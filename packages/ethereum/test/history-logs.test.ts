import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { encodeFunctionData } from "viem";
import type { Context, Checkpoint } from "@confidential-utxo/core";
import { getPoolOperations } from "../src/history.js";
import { poolAbi } from "../src/abi.js";
import type { RpcPolicy } from "../src/rpc.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const context: Context = { chainId: 31337n, pool: "0x1111111111111111111111111111111111111111" as Address,
  deploymentBlock: 10n, verifier: "0x2222222222222222222222222222222222222222", parametersHash: hash("3"),
  finalityMode: "local-simulated" };
const point: Checkpoint = { number: 14n, hash: hash("a"), mode: "local-simulated" };
const policy: RpcPolicy = { chunkBlocks: 2n, minChunkBlocks: 1n, retries: 0,
  requestTimeoutMs: 1000, overallTimeoutMs: 5000 };
const vectors = JSON.parse(readFileSync("tests/vectors/cases/abi-observation.json", "utf8"));
const observation = vectors.find((item: { id: string }) => item.id === "VEC-06-LOG-DEPOSIT");
function logsFor(item: any, txHash = hash("c"), offset = 0) {
  return item.expected.logs.map((entry: any, index: number) => ({
    address: context.pool, topics: entry.topics, data: entry.data,
    blockNumber: 10n, blockHash: hash("b"), transactionHash: txHash,
    transactionIndex: 0, logIndex: offset + index, removed: false,
  }));
}

function fakeClient(logs: unknown[], ranges: [bigint, bigint][], fail?: (from: bigint, to: bigint) => boolean,
  transaction?: { to: Address; input: Hex }): PublicClient {
  return {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      if (fail?.(fromBlock, toBlock)) throw new Error("RPC range limit");
      return logs.filter((log: any) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber,
      hash: blockNumber === point.number ? point.hash : hash("b") }),
    getTransaction: async () => transaction ?? ({ to: "0x3333333333333333333333333333333333333333", input: "0x1234" }),
  } as unknown as PublicClient;
}

it("covers the inclusive history in nonoverlapping chunks and distinguishes an empty range", async () => {
  const ranges: [bigint, bigint][] = [];
  expect(await getPoolOperations(fakeClient([], ranges), context, 10n, point, policy)).toEqual({
    complete: true, blockHash: point.hash, value: [],
  });
  expect(ranges).toEqual([[10n, 11n], [12n, 13n], [14n, 14n]]);
});

it("shrinks a provider-limited range, then reports an unserviceable one-block gap", async () => {
  const ranges: [bigint, bigint][] = [];
  const result = await getPoolOperations(fakeClient([], ranges, (from, to) => from === 10n && to >= 10n),
    context, 10n, point, policy);
  expect(result).toEqual({ complete: false, reason: "GAP" });
  expect(ranges).toContainEqual([10n, 10n]);
});

it("never accepts a provider's overlapping log as complete after a one-block range fails", async () => {
  const ranges: [bigint, bigint][] = [];
  const logs = logsFor(observation);
  const base = fakeClient(logs, ranges);
  const overlap = { ...base, getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
    const part = await base.getLogs(args as Parameters<PublicClient["getLogs"]>[0]);
    return args.fromBlock > 10n ? [...part, logs[0]] : part;
  } } as unknown as PublicClient;
  expect(await getPoolOperations(overlap, context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
  expect(ranges).toContainEqual([12n, 12n]);
});

it("rebuilds a complete Pool operation from independent event bytes", async () => {
  const logs = logsFor(observation);
  const result = await getPoolOperations(fakeClient(logs, []), context, 10n, point, policy);
  expect(result.complete).toBe(true);
  if (!result.complete) return;
  expect(result.value).toHaveLength(1);
  expect(result.value[0]?.success?.operationId).toBe(observation.expected.logs[1].args[0]);
  expect(result.value[0]?.outputLogs).toHaveLength(1);
  expect(result.value[0]?.request.outputs[0]?.packet).toBe(observation.expected.logs[0].args[7]);
});

it.each(["VEC-06-LOG-TRANSFER-CHANGE", "VEC-06-LOG-WITHDRAW-FULL"])(
  "reconstructs independent %s event bytes", async id => {
    const item = vectors.find((entry: { id: string }) => entry.id === id);
    const result = await getPoolOperations(fakeClient(logsFor(item), []), context, 10n, point, policy);
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.request.outputs).toHaveLength(id.includes("WITHDRAW") ? 0 : 2);
  });

it("keeps two successful operations distinct within one outer transaction", async () => {
  const transfer = vectors.find((entry: { id: string }) => entry.id === "VEC-06-LOG-TRANSFER-CHANGE");
  const logs = [...logsFor(observation), ...logsFor(transfer, hash("c"), 2)];
  const result = await getPoolOperations(fakeClient(logs, []), context, 10n, point, policy);
  expect(result.complete).toBe(true);
  if (result.complete) expect(result.value.map(value => value.success?.logIndex)).toEqual([1, 5]);
});

it("does not complete a transaction with an orphan output event", async () => {
  const first = observation.expected.logs[0];
  const logs = [{ address: context.pool, topics: first.topics, data: first.data,
    blockNumber: 10n, blockHash: hash("b"), transactionHash: hash("c"),
    transactionIndex: 0, logIndex: 0, removed: false }];
  expect(await getPoolOperations(fakeClient(logs, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
});

it("rejects negative transaction and log indices from an RPC provider", async () => {
  const shifted = logsFor(observation).map((log: { logIndex: number }) =>
    ({ ...log, logIndex: log.logIndex - 1 }));
  expect(await getPoolOperations(fakeClient(shifted, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
  const negativeTransaction = logsFor(observation).map((log: object) =>
    ({ ...log, transactionIndex: -1 }));
  expect(await getPoolOperations(fakeClient(negativeTransaction, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
});

it("rejects missing and reordered operation events", async () => {
  const transfer = vectors.find((entry: { id: string }) => entry.id === "VEC-06-LOG-TRANSFER-CHANGE");
  const original = logsFor(transfer);
  const missing = original.filter((log: { logIndex: number }) => log.logIndex !== 2);
  expect(await getPoolOperations(fakeClient(missing, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
  const reordered = original.map((log: { logIndex: number }, i: number) =>
    i === 0 ? { ...log, logIndex: 1 } : i === 1 ? { ...log, logIndex: 0 } : log);
  expect(await getPoolOperations(fakeClient(reordered, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "GAP" });
});

it("rejects a log whose claimed block hash disagrees with its header", async () => {
  const logs = logsFor(observation).map((log: { blockHash: Hex }) => ({ ...log, blockHash: hash("d") }));
  expect(await getPoolOperations(fakeClient(logs, []), context, 10n, point, policy))
    .toEqual({ complete: false, reason: "HASH_MISMATCH" });
});

it("rejects direct Pool calldata that does not match its emitted operation", async () => {
  const result = await getPoolOperations(fakeClient(logsFor(observation), [], undefined,
    { to: context.pool, input: encodeFunctionData({ abi: poolAbi, functionName: "verifier" }) }),
  context, 10n, point, policy);
  expect(result).toEqual({ complete: false, reason: "GAP" });
});
