import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, createWalletClient, hexToBytes, http } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { encryptReceipt } from "@confidential-utxo/crypto";
import { authorizeOperation, fixOperation, operationId, outputId, proveFixedOperation,
  receiptInfo, recipientInfoTypedData, toPublicSubmission } from "@confidential-utxo/core";
import type { RecipientInfo } from "@confidential-utxo/core";
import { createOperationSigner, encodePoolSubmission, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import { readOwnerState } from "../../../packages/cli/src/state.js";
import type { CoreAnvilFixture } from "./anvil.js";
import { createCli } from "./cli.js";

export async function prepareRecipients(fixture: CoreAnvilFixture): Promise<{ alice: string; bob: string }> {
  const cli = createCli(fixture);
  for (const actor of [fixture.alice, fixture.bob]) {
    await cli.runOwnerCli(["init", ...actor.args, ...fixture.onlineArgs]);
    await cli.runOwnerCli(["key", "add", ...actor.args]);
    await cli.runOwnerCli(["sync", ...actor.args, ...fixture.onlineArgs]);
  }
  const alice = join(fixture.root, "alice-recipient.json");
  const bob = join(fixture.root, "bob-recipient.json");
  await cli.runOwnerCli(["recipient", ...fixture.alice.args, "--signer", fixture.alice.signer, "--out", alice]);
  await cli.runOwnerCli(["recipient", ...fixture.bob.args, "--signer", fixture.bob.signer, "--out", bob]);
  return { alice, bob };
}

export type CliOperationInput = {
  ownerArgs: string[];
  signer: string;
  kind: "deposit" | "transfer" | "withdraw";
  amountWei: string;
  extra: string[];
};

export async function submitMalformedTransfer(fixture: CoreAnvilFixture, recipientFile: string,
  changeRecipientFile: string,
  variant: "wrong-key" | "commitment-mismatch", amount: bigint): Promise<{
    operationId: Hex; outputId: Hex; txHash: Hex;
  }> {
  const verified = await verifyEthereumDeployment(fixture.client, fixture.manifest, "local-simulated");
  const raw = JSON.parse(await readFile(recipientFile, "utf8")) as Record<string, string | number>;
  const recipient: RecipientInfo = {
    chainId: BigInt(raw.chainId!), pool: raw.pool as RecipientInfo["pool"],
    owner: raw.owner as RecipientInfo["owner"], receivePublicKey: raw.receivePublicKey as Hex,
    receiptFormat: 1, recipientInfoVersion: 1, signature: raw.signature as Hex,
  };
  const changeRaw = JSON.parse(await readFile(changeRecipientFile, "utf8")) as Record<string, string | number>;
  const changeRecipient: RecipientInfo = {
    chainId: BigInt(changeRaw.chainId!), pool: changeRaw.pool as RecipientInfo["pool"],
    owner: changeRaw.owner as RecipientInfo["owner"], receivePublicKey: changeRaw.receivePublicKey as Hex,
    receiptFormat: 1, recipientInfoVersion: 1, signature: changeRaw.signature as Hex,
  };
  const key = async (path: string) => privateKeyToAccount((await readFile(path, "utf8")).trim() as Hex);
  const aliceAccount = await key(fixture.alice.signer);
  const bobAccount = await key(fixture.bob.signer);
  const submitterAccount = await key(fixture.submitter.signer);
  if (variant === "wrong-key") {
    const publicJwk = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" });
    if (!publicJwk.x) throw new Error("missing test receipt public key");
    const unsigned = { ...recipient, receivePublicKey: bytesToHex(Buffer.from(publicJwk.x, "base64url")) };
    recipient.receivePublicKey = unsigned.receivePublicKey;
    recipient.signature = await bobAccount.signTypedData(recipientInfoTypedData(verified.context, unsigned, fixture.bob.address));
  }
  const state = await readOwnerState(fixture.alice.store, Buffer.from("secret"));
  if (state.sync?.status !== "complete") throw new Error("Alice must sync before malformed transfer");
  let fixed = await fixOperation({ kind: 1, owner: fixture.alice.address, amount, recipient,
    changeRecipient }, verified.context, { inputs: state.sync.utxos.filter(item => item.status === "available"),
    randomSalt: () => randomBytes(32) });
  if (variant === "commitment-mismatch") {
    const request = structuredClone(fixed.request);
    const wrongOpening = { ...fixed.openings[0]!, amount: amount + 1n };
    request.outputs[0]!.packet = bytesToHex(await encryptReceipt({
      recipientPublicKey: hexToBytes(recipient.receivePublicKey),
      info: hexToBytes(receiptInfo(verified.context, request, 0)), opening: wrongOpening,
    }));
    const id = operationId(verified.context, request);
    fixed = { ...fixed, request, operationId: id, outputIds: [outputId(id, 0)] };
  }
  const draft = proveFixedOperation(fixed);
  const signature = await authorizeOperation(verified.context, draft.request,
    createOperationSigner(aliceAccount, fixture.alice.address));
  const calldata = encodePoolSubmission(toPublicSubmission({ ...draft, signature }));
  const wallet = createWalletClient({ account: submitterAccount, chain: foundry, transport: http(fixture.rpcUrl) });
  const txHash = await wallet.sendTransaction({ to: verified.context.pool, data: calldata.data,
    value: calldata.value, gas: 15_000_000n });
  const receipt = await fixture.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("malformed receipt operation reverted");
  return { operationId: draft.operationId, outputId: draft.outputIds[0]!, txHash };
}

export async function executeCliOperation(fixture: CoreAnvilFixture, input: CliOperationInput): Promise<{
  operationId: Hex; txHash: Hex;
}> {
  const cli = createCli(fixture);
  const amountFile = join(fixture.root, `amount-${randomUUID()}.json`);
  await writeFile(amountFile, JSON.stringify({ amountWei: input.amountWei }), { mode: 0o600 });
  const created = await cli.runOwnerCli(["create", ...input.ownerArgs, ...fixture.onlineArgs,
    "--kind", input.kind, "--amount-file", amountFile, ...input.extra]);
  const operationId = created.operationId;
  if (typeof operationId !== "string" || !/^0x[0-9a-f]{64}$/i.test(operationId)) {
    throw new Error("CLI create omitted operationId");
  }
  await cli.runOwnerCli(["prove", ...input.ownerArgs, "--id", operationId]);
  await cli.runOwnerCli(["authorize", ...input.ownerArgs, "--id", operationId, "--signer", input.signer]);
  const publicFile = join(fixture.root, `${operationId}.json`);
  await cli.runOwnerCli(["export", ...input.ownerArgs, "--id", operationId, "--out", publicFile]);
  const submitted = await cli.runSubmitterCli(["submit", ...fixture.submitterArgs, "--public", publicFile]);
  const txHash = submitted.txHash;
  if (submitted.status !== "pending" || typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error("CLI submit did not return pending transaction");
  }
  const receipt = await fixture.client.waitForTransactionReceipt({ hash: txHash as Hex });
  if (receipt.status !== "success") throw new Error("CLI submitted transaction reverted");
  const observed = await cli.runSubmitterCli(["operation", ...fixture.submitterArgs, "--id", operationId]);
  if (observed.status !== "executed") throw new Error("CLI operation was not executed");
  return { operationId: operationId as Hex, txHash: txHash as Hex };
}
