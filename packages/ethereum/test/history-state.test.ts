import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import type { Hex, PublicClient } from "viem";
import type { HistoryPort } from "@confidential-utxo/core";
import { poolAbi } from "../src/abi.js";
import { createHistoryPort } from "../src/history.js";
import type { VerifiedDeployment } from "../src/deployment.js";

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const pool = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const point = { number: 10n, hash: hash("a"), mode: "local-simulated" as const };
const verified = { context: { chainId: 31337n, pool, deploymentBlock: 10n,
  verifier: owner, parametersHash: hash("3"), finalityMode: point.mode } } as unknown as VerifiedDeployment;
const policy = { chunkBlocks: 2n, minChunkBlocks: 1n as const, retries: 0,
  requestTimeoutMs: 1000, overallTimeoutMs: 5000 };

function client(status: number, executed = false, options?: { finalized?: boolean; reorg?: boolean;
  noPinned?: boolean; logs?: unknown[] }) {
  let headerReads = 0;
  const state = { pinned: [] as unknown[] };
  const rpc = {
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      if (blockTag === "finalized" && !options?.finalized) throw new Error("unsupported");
      headerReads++;
      return { number: blockNumber ?? 10n, hash: options?.reorg && headerReads > 1 ? hash("b") : point.hash };
    },
    request: async ({ params }: { params: unknown[] }) => {
      state.pinned.push(params[1]);
      if (options?.noPinned) throw new Error("no EIP-1898");
      const input = (params[0] as { data: Hex }).data;
      if (decodeFunctionData({ abi: poolAbi, data: input }).functionName === "isOperationExecuted")
        return encodeFunctionResult({ abi: poolAbi, functionName: "isOperationExecuted", result: executed });
      return encodeFunctionResult({ abi: poolAbi, functionName: "getUtxo", result: [status, owner, 1n, 2n] });
    },
    getLogs: async () => options?.logs ?? [],
    getTransaction: async () => ({ to: owner, input: "0x1234" }),
  } as unknown as PublicClient;
  return { rpc, state };
}

it("implements every HistoryPort method with pinned state and distinct finality", async () => {
  const { rpc, state } = client(1);
  const history: HistoryPort = createHistoryPort(verified, rpc, policy);
  expect(await history.getFinalizedCheckpoint()).toEqual(point);
  expect(await history.getContext(point)).toEqual({ complete: true, blockHash: point.hash, value: verified.context });
  expect(await history.getCanonicalHeader(10n, point)).toMatchObject({ complete: true, blockHash: point.hash });
  expect(await history.getOperations(10n, point)).toEqual({ complete: true, blockHash: point.hash, value: [] });
  expect(await history.getUtxo(hash("1"), point)).toEqual({ complete: true, blockHash: point.hash,
    value: { exists: true, owner, commitment: { x: 1n, y: 2n } } });
  expect(await history.getOperationSuccess(hash("2"), point)).toEqual({ complete: true,
    blockHash: point.hash, value: { executed: false } });
  expect(await history.getLatestHeader()).toEqual({ number: 10n, hash: point.hash });
  expect((await history.getLatestUtxo(hash("1"), point)).complete).toBe(true);
  expect((await history.getLatestOperationSuccess(hash("2"), point)).complete).toBe(true);
  expect(state.pinned).toEqual(Array(4).fill({ blockHash: point.hash, requireCanonical: true }));
});

it("returns no finalized checkpoint when the provider cannot supply one", async () => {
  const { rpc } = client(0, false, { finalized: false });
  const history = createHistoryPort({ ...verified, context: { ...verified.context, finalityMode: "finalized" } }, rpc, policy);
  expect(await history.getFinalizedCheckpoint()).toBeNull();
});

it("preserves absent UTXOs and rejects unsupported pinned reads", async () => {
  const absent = createHistoryPort(verified, client(0).rpc, policy);
  expect(await absent.getUtxo(hash("1"), point)).toEqual({ complete: true, blockHash: point.hash,
    value: { exists: false } });
  const unsupported = createHistoryPort(verified, client(1, false, { noPinned: true }).rpc, policy);
  expect(await unsupported.getUtxo(hash("1"), point)).toEqual({ complete: false, reason: "RPC" });
});

it("reports a reorg between the pre-read and post-read headers", async () => {
  const history = createHistoryPort(verified, client(1, false, { reorg: true }).rpc, policy);
  expect(await history.getUtxo(hash("1"), point)).toEqual({ complete: false, reason: "HASH_MISMATCH" });
});

it("honors an aborted finite policy even when a header RPC never resolves", async () => {
  const abort = new AbortController();
  abort.abort();
  const hanging = { getBlock: () => new Promise<never>(() => {}) } as unknown as PublicClient;
  const history = createHistoryPort(verified, hanging, { ...policy, signal: abort.signal,
    requestTimeoutMs: 5, overallTimeoutMs: 10 });
  const result = await Promise.race([
    history.getUtxo(hash("1"), point),
    new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(result).not.toBe("pending");
  expect(result).toEqual({ complete: false, reason: "RPC" });
});

it("requires complete event evidence for spent UTXOs and executed operations", async () => {
  const spent = createHistoryPort(verified, client(2).rpc, policy);
  expect(await spent.getUtxo(hash("1"), point)).toEqual({ complete: false, reason: "GAP" });
  const executed = createHistoryPort(verified, client(1, true).rpc, policy);
  expect(await executed.getOperationSuccess(hash("2"), point)).toEqual({ complete: false, reason: "GAP" });
});

it("binds a spent UTXO and an executed operation to reconstructed events", async () => {
  const vectors = JSON.parse(readFileSync("tests/vectors/cases/abi-observation.json", "utf8"));
  const transfer = vectors.find((item: { id: string }) => item.id === "VEC-06-LOG-TRANSFER-CHANGE");
  const logs = transfer.expected.logs.map((entry: { topics: Hex[]; data: Hex }, logIndex: number) => ({
    address: pool, topics: entry.topics, data: entry.data, blockNumber: 10n, blockHash: point.hash,
    transactionHash: hash("c"), transactionIndex: 0, logIndex, removed: false,
  }));
  const history = createHistoryPort(verified, client(2, true, { logs }).rpc, policy);
  const id = transfer.expected.logs[0].args[0] as Hex;
  const operationId = transfer.expected.logs[3].args[0] as Hex;
  expect(await history.getUtxo(id, point)).toEqual({ complete: true, blockHash: point.hash,
    value: { exists: true, owner, commitment: { x: 1n, y: 2n }, consumedBy: operationId } });
  const result = await history.getOperationSuccess(operationId, point);
  expect(result.complete && result.value.operation?.inputIds).toEqual([id]);
});
