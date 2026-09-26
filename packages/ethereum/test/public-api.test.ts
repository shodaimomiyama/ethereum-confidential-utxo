import { expect, it } from "vitest";
import { createWalletClient, custom, publicActions } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { authorizationTypedData, recipientInfoTypedData,
  verifyOperationAuthorization, verifyRecipientInfo } from "@confidential-utxo/core";
import type { HistoryPort, OperationRequest, RecipientInfo } from "@confidential-utxo/core";
import { createOperationSigner, createRecipientInfoSigner, defaultRpcPolicy,
  encodePoolSubmission, poolAbi, submitPublicOperation } from "@confidential-utxo/ethereum";
import type { VerifiedDeployment } from "@confidential-utxo/ethereum";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const context = { chainId: 31337n, pool: "0x1111111111111111111111111111111111111111" as const };

it("AC-02/12: exposes both EIP-712 signers through the package entrypoints for an external Wallet Client", async () => {
  const wallet = createWalletClient({ account, transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_accounts") return [account.address];
    throw new Error(`unexpected method ${method}`);
  } }) });
  const request: OperationRequest = { kind: 2, owner: account.address, salt: `0x${"11".repeat(32)}`,
    inputIds: [`0x${"22".repeat(32)}`], outputs: [], d: 0n, w: 1n, destination: account.address };
  const operation = authorizationTypedData(context, request);
  const signature = await createOperationSigner(wallet, account.address).signTypedData(operation);
  await expect(verifyOperationAuthorization(context, operation.message.operationId, account.address, signature))
    .resolves.toBeUndefined();
  const recipient: Omit<RecipientInfo, "signature"> = { ...context, owner: account.address,
    receivePublicKey: `0x${"33".repeat(32)}`, receiptFormat: 1, recipientInfoVersion: 1 };
  const info = recipientInfoTypedData(context, recipient, account.address);
  const recipientSignature = await createRecipientInfoSigner(wallet, account.address).signTypedData(info);
  await expect(verifyRecipientInfo(context, { ...recipient, signature: recipientSignature }, account.address))
    .resolves.toBeUndefined();
  expect(defaultRpcPolicy.chunkBlocks).toBe(2000n);
  expect(poolAbi.some(item => item.type === "function" && item.name === "withdraw")).toBe(true);
  expect(encodePoolSubmission).toBeTypeOf("function");
});

it("AC-02/09/12: sends an approved public request through a controlled EIP-1193 Wallet Client", async () => {
  const sent: unknown[] = [];
  const wallet = createWalletClient({ account: account.address, chain: foundry,
    transport: custom({ request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse((params as string[])[1]!);
        return account.signTypedData(typed);
      }
      if (method === "eth_getBalance") return "0xde0b6b3a7640000";
      if (method === "eth_sendTransaction") { sent.push((params as unknown[])[0]); return `0x${"aa".repeat(32)}`; }
      throw new Error(`unexpected ${method}`);
    } }) }).extend(publicActions);
  const request: OperationRequest = { kind: 2, owner: account.address, salt: `0x${"11".repeat(32)}`,
    inputIds: [`0x${"22".repeat(32)}`], outputs: [], d: 0n, w: 1n, destination: account.address };
  const signature = await createOperationSigner(wallet, account.address)
    .signTypedData(authorizationTypedData(context, request));
  const point = { number: 1n, hash: `0x${"bb".repeat(32)}` as Hex, mode: "local-simulated" as const };
  const fullContext = { ...context, deploymentBlock: 1n, verifier: account.address,
    parametersHash: `0x${"cc".repeat(32)}` as Hex, finalityMode: point.mode };
  const complete = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => point,
    getContext: async () => complete(fullContext),
    getCanonicalHeader: async () => complete({ number: point.number, hash: point.hash }),
    getOperations: async () => complete([]),
    getUtxo: async () => complete({ exists: true }),
    getOperationSuccess: async () => complete({ executed: false }),
    getLatestHeader: async () => point,
    getLatestUtxo: async () => complete({ exists: true, owner: account.address, commitment: { x: 1n, y: 2n } }),
    getLatestOperationSuccess: async () => complete({ executed: false }),
  };
  const verified = { context: fullContext } as unknown as VerifiedDeployment;
  const result = await submitPublicOperation(verified, history, wallet, account.address,
    { request, balanceProof: { Rx: 1n, Ry: 2n, s: 1n }, rangeProofs: [], signature },
    { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n });
  expect(result.attempt.outer).toBe("pending");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: context.pool });
});
