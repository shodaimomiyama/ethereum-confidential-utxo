import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createPublicClient, createWalletClient, hexToBytes, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { authorizeOperation, buildOperation, preflightSubmission, prepareSubmission, recipientInfoTypedData, synchronize } from "@confidential-utxo/core";
import type { LocalDraft, RecipientInfo, SyncResult } from "@confidential-utxo/core";
import { createHistoryPort, createOperationSigner, createRecipientInfoSigner,
  defaultRpcPolicy, encodePoolSubmission, observeAttempt, replaceSubmissionFee, submitPublicOperation,
  verifyEthereumDeployment } from "@confidential-utxo/ethereum";

const require = createRequire(import.meta.url);
const { deployPool } = require("../../../scripts/pool-deployment.mjs") as {
  deployPool(input: { rpcUrl: string; expectedChainId: number; privateKey: string; hardfork: string }): Promise<unknown>;
};
const submitterKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const receiver = JSON.parse(readFileSync("tests/vectors/cases/application-operation.json", "utf8"))
  .find((item: { id: string }) => item.id === "VEC-07-APPLICATION-DEPOSIT").expected.receipts[0];

async function withAnvil(run: (url: string) => Promise<void>) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      server.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("anvil", ["--silent", "--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--hardfork", "cancun", "--gas-limit", "30000000"], { stdio: "ignore" });
  try {
    const client = createPublicClient({ transport: http(url) });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try { ready = await client.getChainId() === 31337; } catch { /* wait */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Anvil startup timed out");
    await run(url);
  } finally { child.kill("SIGTERM"); }
}

it("AC-04/05/06/09: runs real deposit, partial transfer, full UTXO withdrawal, relay, and fee replacement", async () => {
  await withAnvil(async url => {
    const client = createPublicClient({ transport: http(url) });
    const manifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
      privateKey: submitterKey, hardfork: "cancun" });
    const verified = await verifyEthereumDeployment(client, manifest, "local-simulated");
    const context = verified.context;
    const history = createHistoryPort(verified, client, defaultRpcPolicy);
    const submitter = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const funder = createWalletClient({ account: privateKeyToAccount(submitterKey),
      chain: foundry, transport: http(url) });
    const funding = await funder.sendTransaction({ to: submitter.address, value: 1_000_000_000_000_000_000n });
    await client.waitForTransactionReceipt({ hash: funding });
    const wallet = createWalletClient({ account: submitter, chain: foundry, transport: http(url) }).extend(publicActions);
    const recipientBase = { chainId: context.chainId, pool: context.pool, owner: owner.address,
      receivePublicKey: receiver.recipientInfo.receivePublicKey,
      receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
    const recipientSigner = createRecipientInfoSigner(owner, owner.address);
    const recipient: RecipientInfo = { ...recipientBase,
      signature: await recipientSigner.signTypedData(recipientInfoTypedData(context, recipientBase, owner.address)) };
    const keys = { getKey: async () => hexToBytes(receiver.recipientPrivateKey) };
    const storage = { saveDraft: async (_draft: LocalDraft) => "saved" as const };
    const signer = createOperationSigner(owner, owner.address);
    let prior: SyncResult | undefined;
    async function perform(kind: 0 | 1 | 2, amount: bigint, input: SyncResult | undefined) {
      const available = input?.status === "complete" ? input.utxos.filter(item => item.status === "available") : [];
      const intent = kind === 0 ? { kind, owner: owner.address, amount, recipient } as const :
        kind === 1 ? { kind, owner: owner.address, amount, recipient, changeRecipient: recipient } as const :
          { kind, owner: owner.address, amount, destination: owner.address } as const;
      const draft = await buildOperation(intent, context, { inputs: available,
        randomSalt: () => new Uint8Array(32).fill(kind + 1) });
      const signed = { ...draft, signature: await authorizeOperation(context, draft.request, signer) };
      const prepared = await prepareSubmission(signed, { history, keys, storage });
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") throw new Error("preflight failed");
      const before = await client.getBalance({ address: submitter.address });
      const sent = await submitPublicOperation(verified, history, wallet, submitter.address,
        prepared.submission, {});
      expect(sent.attempt.outer).toBe("pending");
      const receipt = await client.waitForTransactionReceipt({ hash: sent.attempt.txHash! });
      expect(receipt.status).toBe("success");
      const after = await client.getBalance({ address: submitter.address });
      expect(after).toBeLessThan(before - sent.value);
      const observed = await observeAttempt(history, client, sent.operationId, sent.attempt.txHash!, defaultRpcPolicy);
      expect(observed.observation).toMatchObject({ outer: "success", operation: "executed" });
      expect(observed.gas?.gasUsed).toBeGreaterThan(0n);
      const synced = await synchronize(context, { history, keys, owners: [owner.address] }, prior);
      expect(synced.status).toBe("complete");
      prior = synced;
      return synced;
    }
    const deposit = await perform(0, 10n, undefined);
    expect(deposit.status === "complete" && deposit.availableWei).toBe(10n);
    const transferred = await perform(1, 3n, deposit);
    expect(transferred.status === "complete" && transferred.availableWei).toBe(10n);
    const withdrawn = await perform(2, 7n, transferred);
    expect(withdrawn.status === "complete" && withdrawn.availableWei).toBe(3n);

    // A relay forwards calldata, ignores CALL's return flag, and stops successfully.
    const relayRuntime = `36600060003760006000366000600073${context.pool.slice(2)}5af15000`;
    const relayLength = (relayRuntime.length / 2).toString(16).padStart(2, "0");
    const relayInitcode = `0x60${relayLength}600c60003960${relayLength}6000f3${relayRuntime}` as const;
    const deployedRelay = await wallet.sendTransaction({ data: relayInitcode, gas: 500000n });
    const relayDeployment = await client.waitForTransactionReceipt({ hash: deployedRelay });
    expect(relayDeployment.contractAddress).not.toBeNull();
    const relayDraft = await buildOperation({ kind: 1, owner: owner.address, amount: 3n, recipient },
      context, { inputs: withdrawn.status === "complete" ? withdrawn.utxos.filter(item => item.status === "available") : [],
        randomSalt: () => new Uint8Array(32).fill(8) });
    const relaySigned = { ...relayDraft,
      signature: await authorizeOperation(context, relayDraft.request, signer) };
    const relayPrepared = await prepareSubmission(relaySigned, { history, keys, storage });
    expect(relayPrepared.status).toBe("ready");
    if (relayPrepared.status !== "ready") throw new Error("relay preflight failed");
    const relayCall = encodePoolSubmission(relayPrepared.submission);
    const relayHash = await wallet.sendTransaction({ to: relayDeployment.contractAddress!,
      data: relayCall.data, gas: 15_000_000n });
    const relayReceipt = await client.waitForTransactionReceipt({ hash: relayHash });
    expect(relayReceipt.status).toBe("success");
    const relayObserved = await observeAttempt(history, client, relayDraft.operationId, relayHash, defaultRpcPolicy);
    expect(relayObserved.observation).toMatchObject({ outer: "success", operation: "executed" });
    expect(relayObserved.observation.evidence?.event.success?.transactionHash).toBe(relayHash);
    const relaySynced = await synchronize(context, { history, keys, owners: [owner.address] }, prior);
    expect(relaySynced.status === "complete" && relaySynced.availableWei).toBe(3n);

    const repricedDraft = await buildOperation({ kind: 0, owner: owner.address, amount: 1n, recipient },
      context, { inputs: [], randomSalt: () => new Uint8Array(32).fill(9) });
    const signed = { ...repricedDraft,
      signature: await authorizeOperation(context, repricedDraft.request, signer) };
    const prepared = await prepareSubmission(signed, { history, keys, storage });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("replacement preflight failed");
    const estimated = await wallet.estimateFeesPerGas();
    const initialFee = estimated.maxFeePerGas!;
    const initialTip = estimated.maxPriorityFeePerGas!;
    await client.request({ method: "anvil_setAutomine", params: [false] } as Parameters<typeof client.request>[0]);
    try {
      const first = await submitPublicOperation(verified, history, wallet, submitter.address,
        prepared.submission, { gas: 5_000_000n, maxFeePerGas: initialFee, maxPriorityFeePerGas: initialTip });
      expect(first.attempt.outer).toBe("pending");
      const replacement = await replaceSubmissionFee(verified, history, wallet, first,
        { maxFeePerGas: initialFee * 2n, maxPriorityFeePerGas: initialTip * 2n });
      expect(replacement.attempt.outer).toBe("pending");
      expect(replacement.operationId).toBe(first.operationId);
      expect(replacement.calldata).toBe(first.calldata);
      expect(replacement.nonce).toBe(first.nonce);
      expect(replacement.attempts).toHaveLength(2);
      expect(replacement.attempt.txHash).not.toBe(first.attempt.txHash);
      await client.request({ method: "anvil_mine", params: ["0x1"] } as Parameters<typeof client.request>[0]);
      const receipt = await client.getTransactionReceipt({ hash: replacement.attempt.txHash! });
      expect(receipt.status).toBe("success");
    } finally {
      await client.request({ method: "anvil_setAutomine", params: [true] } as Parameters<typeof client.request>[0]);
    }

    const lostDraft = await buildOperation({ kind: 0, owner: owner.address, amount: 1n, recipient },
      context, { inputs: [], randomSalt: () => new Uint8Array(32).fill(10) });
    const lostSigned = { ...lostDraft,
      signature: await authorizeOperation(context, lostDraft.request, signer) };
    const lostPrepared = await prepareSubmission(lostSigned, { history, keys, storage });
    expect(lostPrepared.status).toBe("ready");
    if (lostPrepared.status !== "ready") throw new Error("lost-response preflight failed");
    let acceptedHash: `0x${string}` | undefined;
    const lostWallet = { ...wallet, sendTransaction: async (args: Parameters<typeof wallet.sendTransaction>[0]) => {
      acceptedHash = await wallet.sendTransaction(args);
      throw new Error("response lost after node acceptance");
    } };
    const uncertain = await submitPublicOperation(verified, history, lostWallet, submitter.address,
      lostPrepared.submission, {});
    expect(uncertain.attempt).toEqual({ outer: "unconfirmed" });
    expect(uncertain.operationId).toBe(lostDraft.operationId);
    expect(acceptedHash).toBeDefined();
    expect((await client.waitForTransactionReceipt({ hash: acceptedHash! })).status).toBe("success");
    expect((await preflightSubmission(context, lostDraft.request, { history })).status).toBe("executed");
  });
}, 180_000);
