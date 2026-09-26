import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { commit, encryptReceipt } from "@confidential-utxo/crypto";
import { bytesToHex, hexToBytes, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { operationId, outputId, receiptInfo, selectInputs, synchronize } from "../src/index.js";
import type { Checkpoint, Context, HistoryPort, Observation, ObservedOperation, OperationRequest } from "../src/index.js";
const vector = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/application-operation.json", import.meta.url), "utf8"))[0];
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const owner = vector.input.owner as Address;
const context: Context = { chainId: 31337n, pool: vector.input.pool, deploymentBlock: 1n, verifier: zeroAddress, parametersHash: hash("00"), finalityMode: "finalized" };
function observed(request: OperationRequest, height: bigint): ObservedOperation {
  const id = operationId(context, request);
  const location = { blockNumber: height, blockHash: hash(height.toString(16).padStart(2, "0")), transactionHash: hash((height + 100n).toString(16)), transactionIndex: 0 };
  return { request, success: { ...location, operationId: id, logIndex: request.inputIds.length + request.outputs.length },
    inputLogs: request.inputIds.map((inputId, logIndex) => ({ ...location, operationId: id, inputId, logIndex })),
    outputLogs: request.outputs.map((output, i) => ({ ...location, operationId: id, output, outputId: outputId(id, i), outputIndex: i, logIndex: request.inputIds.length + i })) };
}
async function fixture() {
  const operations: ObservedOperation[] = [];
  for (const amount of [3n, 7n]) {
    const opening = { amount, blinding: amount };
    const request: OperationRequest = { kind: 0, owner, salt: hash(amount.toString().padStart(2, "0")), inputIds: [], outputs: [{ owner, commitment: commit(opening), receiptFormat: 1, packet: `0x${"00".repeat(112)}` }], d: amount, w: 0n, destination: zeroAddress };
    request.outputs[0]!.packet = bytesToHex(await encryptReceipt({ recipientPublicKey: hexToBytes(vector.expected.receipts[0].recipientPublicKey), opening, info: hexToBytes(receiptInfo(context, request, 0)) }));
    operations.push(observed(request, amount));
  }
  operations.push(observed({ kind: 2, owner, salt: hash("99"), inputIds: [operations[0]!.outputLogs[0]!.outputId], outputs: [], d: 0n, w: 3n, destination: owner }, 10n));
  const f = { point: { number: 20n, hash: hash("20"), mode: "finalized" } as Checkpoint, operations, identity: { ...context } };
  const complete = <T>(value: T): Observation<T> => ({ complete: true, blockHash: f.point.hash, value });
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => structuredClone(f.point),
    getContext: async () => complete(f.identity),
    getCanonicalHeader: async number => complete({ number, hash: number === f.point.number ? f.point.hash : hash(number.toString(16).padStart(2, "0")) }),
    getOperations: async (from, point) => { expect(from).toBe(context.deploymentBlock); expect(point).toEqual(f.point); return complete(f.operations); },
    getUtxo: async id => {
      const output = f.operations.flatMap(op => op.outputLogs).find(log => log.outputId === id)?.output;
      const consumedBy = f.operations.find(op => op.request.inputIds.includes(id))?.success?.operationId;
      return complete(output ? { exists: true, owner: output.owner, commitment: output.commitment, ...(consumedBy ? { consumedBy } : {}) } : { exists: false });
    },
    getOperationSuccess: async id => { const op = f.operations.find(op => op.success?.operationId === id); return complete(op ? { executed: true, operation: op.request } : { executed: false }); },
    getLatestHeader: async () => null,
    getLatestUtxo: async () => ({ complete: false, reason: "RPC" }),
    getLatestOperationSuccess: async () => ({ complete: false, reason: "RPC" }),
  };
  return { ...f, state: f, history, complete, owners: [owner], keys: { getKey: async () => hexToBytes(vector.expected.receipts[0].recipientPrivateKey) } };
}
it("AC-06: VEC-07-APPLICATION-DEPOSIT key supports repeated synthetic creation/spend history", async () => {
  const f = await fixture();
  const first = await synchronize(context, f);
  const second = await synchronize(context, f, first);
  expect(first.status).toBe("complete");
  expect(second).toEqual(first);
  if (second.status !== "complete") throw new Error("sync rejected");
  expect(second.availableWei).toBe(7n);
  expect(second.utxos.map(u => u.status)).toEqual(["spent", "available"]);
  expect(selectInputs(context, second.utxos, { kind: 2, owner, amount: 7n })).toHaveLength(1);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const failures: [string, (f: Fixture) => void][] = [
  ["partial range", f => { f.history.getOperations = async () => ({ complete: false, reason: "GAP" }); }],
  ["mixed range hash", f => { f.history.getOperations = async () => ({ complete: true, blockHash: hash("ff"), value: f.operations }); }],
  ["RPC exception", f => { f.history.getOperations = async () => { throw new Error("private detail"); }; }],
  ["missing finalized", f => { f.history.getFinalizedCheckpoint = async () => null; }],
  ["wrong finality", f => { f.state.point.mode = "local-simulated"; }],
  ["checkpoint before deployment", f => { f.state.point.number = 0n; }],
  ["missing identity", f => { f.history.getContext = async () => ({ complete: false, reason: "RPC" }); }],
  ["mixed identity hash", f => { f.history.getContext = async () => ({ complete: true, blockHash: hash("ff"), value: context }); }],
  ["wrong chain", f => { f.identity.chainId++; }],
  ["wrong Pool", f => { f.identity.pool = owner; }],
  ["wrong deployment", f => { f.identity.deploymentBlock++; }],
  ["wrong verifier", f => { f.identity.verifier = owner; }],
  ["wrong parameters", f => { f.identity.parametersHash = hash("ff"); }],
  ["duplicate operation", f => { f.operations.push(f.operations[0]!); }],
  ["missing output", f => { f.operations[0]!.outputLogs = []; }],
  ["duplicate output", f => { f.operations[0]!.outputLogs.push(f.operations[0]!.outputLogs[0]!); }],
  ["missing success", f => { delete f.operations[0]!.success; }],
  ["missing input log", f => { delete f.operations[2]!.inputLogs; }],
  ["wrong input id", f => { f.operations[2]!.inputLogs![0]!.inputId = hash("ff"); }],
  ["wrong input position", f => { f.operations[2]!.inputLogs![0]!.logIndex = 8; }],
  ["wrong operation id", f => { f.operations[0]!.success!.operationId = hash("ff"); }],
  ["wrong output id", f => { f.operations[0]!.outputLogs[0]!.outputId = hash("ff"); }],
  ["wrong packet", f => { f.operations[0]!.outputLogs[0]!.output = { ...f.operations[0]!.request.outputs[0]!, packet: hash("ff") }; }],
  ["wrong log transaction", f => { f.operations[0]!.outputLogs[0]!.transactionHash = hash("ff"); }],
  ["missing creation header", f => { f.history.getCanonicalHeader = async () => ({ complete: false, reason: "GAP" }); }],
  ["mixed creation envelope hash", f => { f.history.getCanonicalHeader = async number => ({ complete: true, blockHash: hash("ff"), value: { number, hash: hash("03") } }); }],
  ["wrong creation ancestry", f => { f.history.getCanonicalHeader = async number => f.complete({ number, hash: hash("ff") }); }],
  ["missing success state", f => { f.history.getOperationSuccess = async () => ({ complete: false, reason: "RPC" }); }],
  ["unsuccessful operation", f => { f.history.getOperationSuccess = async () => f.complete({ executed: false }); }],
  ["mixed UTXO hash", f => { f.history.getUtxo = async () => ({ complete: true, blockHash: hash("ff"), value: { exists: true } }); }],
  ["missing UTXO state", f => { f.history.getUtxo = async () => ({ complete: false, reason: "GAP" }); }],
  ["UTXO absent", f => { f.history.getUtxo = async () => f.complete({ exists: false }); }],
  ["contradictory spend", f => { const get = f.history.getUtxo; f.history.getUtxo = async (...args) => { const state = await get(...args); if (state.complete) delete state.value.consumedBy; return state; }; }],
  ["unknown consuming operation", f => { const get = f.history.getUtxo; f.history.getUtxo = async (...args) => { const state = await get(...args); if (state.complete) state.value.consumedBy = hash("ff"); return state; }; }],
  ["missing key", f => { f.keys.getKey = async () => { throw new Error("private key detail"); }; }],
  ["missing ancestor creation", f => { f.operations.shift(); }],
  ["reorg during synchronization", f => { const get = f.history.getCanonicalHeader; f.history.getCanonicalHeader = async (number, point) => number === point.number ? { complete: false, reason: "HASH_MISMATCH" } : get(number, point); }],
];
it.each(failures)("AC-06: returns only stale previous state for %s", async (_, mutate) => {
  const f = await fixture();
  const previous = await synchronize(context, f);
  expect(previous.status).toBe("complete");
  mutate(f);
  const result = await synchronize(context, f, previous);
  expect(result.status).toBe("unconfirmed");
  expect(result).not.toHaveProperty("availableWei");
  expect(result).not.toHaveProperty("utxos");
  if (result.status !== "unconfirmed") throw new Error("accepted invalid history");
  expect(result.previous?.status).toBe("stale");
  expect(result.previous).not.toHaveProperty("availableWei");
  expect(result.previous?.utxos.every(u => u.status === "unknown")).toBe(true);
  expect(() => selectInputs(context, result.previous!.utxos, { kind: 2, owner, amount: 7n })).toThrow();
  expect(JSON.stringify(result, (_, v) => typeof v === "bigint" ? String(v) : v)).not.toContain("private");
  if (previous.status === "complete") expect(previous.utxos[1]!.status).toBe("available");
});
it("AC-07: rebuilds after finalized reorg reverting a creation", async () => {
  const f = await fixture();
  const previous = await synchronize(context, f);
  f.state.point.hash = hash("21");
  f.operations.splice(1, 1);
  const result = await synchronize(context, f, previous);
  expect(result).toMatchObject({ status: "complete", checkpoint: { hash: hash("21") }, availableWei: 0n });
  if (result.status === "complete") expect(result.utxos).toHaveLength(1);
});
it("AC-07: rebuilds after finalized reorg reverting a consumption", async () => {
  const f = await fixture();
  const previous = await synchronize(context, f);
  f.state.point.hash = hash("21");
  f.operations.pop();
  expect(await synchronize(context, f, previous)).toMatchObject({ status: "complete", availableWei: 10n });
});
it("does not expose reverted coins when reorg rebuild fails", async () => {
  const f = await fixture();
  const previous = await synchronize(context, f);
  f.state.point.hash = hash("21");
  f.history.getOperations = async () => ({ complete: false, reason: "GAP" });
  const result = await synchronize(context, f, previous);
  expect(result).toMatchObject({ status: "unconfirmed", checkpoint: { hash: hash("21") }, previous: { status: "stale", checkpoint: { hash: hash("20") } } });
  expect(result).not.toHaveProperty("availableWei");
});
it("allows local simulation only with matching explicit context", async () => {
  const f = await fixture();
  f.state.point.mode = "local-simulated";
  f.identity.finalityMode = "local-simulated";
  expect(await synchronize({ ...context, finalityMode: "local-simulated" }, f)).toMatchObject({ status: "complete", availableWei: 7n });
});
it("excludes other owners without requesting their keys", async () => {
  const f = await fixture();
  f.owners = [zeroAddress];
  f.keys.getKey = async () => { throw new Error("must not request foreign key"); };
  expect(await synchronize(context, f)).toMatchObject({ status: "complete", availableWei: 0n, utxos: [] });
});
it("retains stale data across repeated failures and succeeds after history recovers", async () => {
  const f = await fixture();
  const previous = await synchronize(context, f);
  const get = f.history.getOperations;
  f.history.getOperations = async () => ({ complete: false, reason: "GAP" });
  const failure = await synchronize(context, f, previous);
  expect(await synchronize(context, f, failure)).toEqual(failure);
  f.history.getOperations = get;
  expect(await synchronize(context, f, failure)).toEqual(previous);
});
it("normalizes RPC operation order and snapshots observations before key access", async () => {
  const f = await fixture();
  f.operations.reverse();
  const get = f.keys.getKey;
  f.keys.getKey = async () => { f.operations[2]!.request.outputs[0]!.owner = zeroAddress; return get(); };
  expect(await synchronize(context, f)).toMatchObject({ status: "complete", availableWei: 7n });
});
it("rejects block log order contradicting transaction order", async () => {
  const f = await fixture();
  const first = f.operations[0]!;
  const second = f.operations[1]!;
  for (const log of [...first.outputLogs, first.success!]) log.logIndex += 10;
  for (const log of [...second.outputLogs, second.success!]) {
    log.blockNumber = first.success!.blockNumber;
    log.blockHash = first.success!.blockHash;
    log.transactionIndex = 1;
  }
  expect(await synchronize(context, f)).toMatchObject({ status: "unconfirmed", reason: "INCONSISTENT_HISTORY" });
});
it("rejects a second operation consuming an already consumed input", async () => {
  const f = await fixture();
  f.operations.push(observed({ ...f.operations[2]!.request, salt: hash("98") }, 11n));
  expect(await synchronize(context, f)).toMatchObject({ status: "unconfirmed", reason: "INCONSISTENT_HISTORY" });
});
it("rejects an empty owner scope instead of claiming a zero wallet balance", async () => {
  const f = await fixture();
  expect(await synchronize(context, { ...f, owners: [] })).toEqual({ status: "unconfirmed", reason: "CONTEXT" });
});

it("preserves per-output failure when keys cannot decrypt, excluding those outputs from funds", async () => {
  const f = await fixture();
  f.keys.getKey = async () => new Uint8Array(32).fill(1);
  const result = await synchronize(context, f);
  expect(result).toMatchObject({ status: "complete", availableWei: 0n, utxos: [] });
  if (result.status !== "complete") throw new Error("history incomplete");
  expect(result.receiptFailures).toHaveLength(2);
  expect(result.receiptFailures.every(r => r.reason === "DECRYPT")).toBe(true);
});
