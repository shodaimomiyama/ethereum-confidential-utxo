import { expect, it } from "vitest";
import { encodeErrorResult, TransactionReceiptNotFoundError } from "viem";
import type { Hex, PublicClient } from "viem";
import { operationId, trackAttempt } from "@confidential-utxo/core";
import type { HistoryPort, ObservedOperation, Context } from "@confidential-utxo/core";
import { poolAbi } from "../src/abi.js";
import { decodePoolFailure, observeAttempt } from "../src/observation.js";

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const txHash = hex(20);
const point = { number: 10n, hash: hex(10), mode: "local-simulated" as const };
const context: Context = { chainId: 31337n, pool: "0x1111111111111111111111111111111111111111",
  deploymentBlock: 1n, verifier: "0x2222222222222222222222222222222222222222",
  parametersHash: hex(3), finalityMode: point.mode };
const request = { kind: 2 as const, owner: context.verifier, salt: hex(1), inputIds: [hex(2)],
  outputs: [], d: 0n, w: 10n, destination: context.verifier };
const id = operationId(context, request);
const event: ObservedOperation = { request, outputLogs: [], success: { operationId: id,
  blockNumber: 10n, blockHash: point.hash, transactionHash: hex(30), transactionIndex: 0, logIndex: 0 },
  inputLogs: [{ operationId: id, inputId: hex(2), blockNumber: 10n, blockHash: point.hash,
    transactionHash: hex(30), transactionIndex: 0, logIndex: 0 }] };
const policy = { chunkBlocks: 10n, minChunkBlocks: 1n as const, retries: 0,
  requestTimeoutMs: 1000, overallTimeoutMs: 5000 };
const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });

function history(found = false, reorg = false): HistoryPort {
  return {
    getFinalizedCheckpoint: async () => reorg ? { ...point, hash: hex(11) } : point,
    getContext: async () => bound(context),
    getCanonicalHeader: async () => reorg ? { complete: false, reason: "HASH_MISMATCH" } : bound({ number: 10n, hash: point.hash }),
    getOperations: async () => bound(found ? [event] : []),
    getUtxo: async () => bound({ exists: false }),
    getOperationSuccess: async () => bound({ executed: found, ...(found ? { operation: request } : {}) }),
    getLatestHeader: async () => point,
    getLatestUtxo: async () => bound({ exists: false }),
    getLatestOperationSuccess: async () => bound({ executed: found }),
  } as HistoryPort;
}
function client(status: "success" | "reverted" | "missing", blockHash = point.hash): PublicClient {
  return {
    getTransactionReceipt: async () => {
      if (status === "missing") throw new TransactionReceiptNotFoundError({ hash: txHash });
      return { transactionHash: txHash, status, blockNumber: 10n, blockHash,
        gasUsed: 21000n, effectiveGasPrice: 3n };
    },
    getBlock: async () => ({ number: 10n, hash: blockHash }),
  } as unknown as PublicClient;
}

it("keeps missing receipts pending and separates outer failure from logical success", async () => {
  expect((await observeAttempt(history(), client("missing"), id, txHash, policy)).observation)
    .toEqual({ txHash, outer: "pending", operation: "unconfirmed" });
  const failed = await observeAttempt(history(), client("reverted"), id, txHash, policy);
  expect(failed.observation).toMatchObject({ outer: "failed", failure: "OUTER_REVERT" });
  expect(failed.gas).toEqual({ gasUsed: 21000n, effectiveGasPrice: 3n });
  const relay = await observeAttempt(history(), client("success"), id, txHash, policy);
  expect(relay.observation).toMatchObject({ outer: "success", operation: "unconfirmed" });
  expect(trackAttempt(id, relay.observation, []).receipt).toBe("unconfirmed");
});

it("adopts a separately submitted finalized operation and revokes it after reorg", async () => {
  const first = await observeAttempt(history(true), client("reverted"), id, txHash, policy);
  expect(first.observation.evidence?.event.success?.transactionHash).toBe(hex(30));
  const tracked = trackAttempt(id, first.observation, []);
  expect(tracked.operation).toBe("executed");
  expect(tracked.attempts[0]?.outer).toBe("failed");
  const changed = await observeAttempt(history(true, true), client("success"), id, txHash, policy);
  expect(changed.observation.historyStatus).toBe("reorg");
  expect(trackAttempt(id, changed.observation, tracked).operation).toBe("unconfirmed");
});

it("decodes only known Pool errors", () => {
  const known = encodeErrorResult({ abi: poolAbi, errorName: "InputAlreadySpent", args: [hex(2)] });
  expect(decodePoolFailure(known)).toEqual({ name: "InputAlreadySpent", args: [hex(2)] });
  expect(decodePoolFailure("0x")).toEqual({ name: "UNKNOWN" });
  expect(decodePoolFailure("0x12345678")).toEqual({ name: "UNKNOWN" });
});
