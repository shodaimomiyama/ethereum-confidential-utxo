import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeEventLog, parseAbi, hexToBytes, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { inspectReceipt, operationId } from "../src/index.js";
import type { Checkpoint, Context, Observation, ObservedOperation, OperationRequest, ReceiptState } from "../src/index.js";

type Vector = { id: string; input: { chainId: string; pool: Address; kind: 0 | 1 | 2; owner: Address; salt: Hex; inputIds: Hex[]; d: string; w: string; destination: Address; outputs: { owner: Address; Cx: string; Cy: string; receiptFormat: 1; packet: Hex }[] }; expected: { operationId: Hex; outputIds: { hash: Hex }[]; receipts: { recipientPrivateKey: Hex; value: string; blinding: string }[] } };
const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/application-operation.json", import.meta.url), "utf8")) as Vector[];
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const checkpoint: Checkpoint = { number: 20n, hash: hash("20"), mode: "finalized" };
const complete = <T>(value: T): Observation<T> => ({ complete: true, blockHash: checkpoint.hash, value });
function fixture(vector = vectors[1]!) {
  const input = vector.input;
  const context: Context = { chainId: BigInt(input.chainId), pool: input.pool, deploymentBlock: 1n, verifier: zeroAddress, parametersHash: hash("00"), finalityMode: "finalized" };
  const request: OperationRequest = { ...input, d: BigInt(input.d), w: BigInt(input.w), outputs: input.outputs.map(o => ({ owner: o.owner, commitment: { x: BigInt(o.Cx), y: BigInt(o.Cy) }, receiptFormat: o.receiptFormat, packet: o.packet })) };
  const location = { blockNumber: 10n, blockHash: hash("10"), transactionHash: hash("11"), transactionIndex: 0 };
  const observed: ObservedOperation = { request, success: { ...location, logIndex: request.outputs.length + 1, operationId: vector.expected.operationId }, outputLogs: request.outputs.map((_, i) => ({ ...location, logIndex: i + 1, outputIndex: i, operationId: vector.expected.operationId, output: structuredClone(request.outputs[i]!), outputId: vector.expected.outputIds[i]!.hash })) };
  const state: ReceiptState = { context, creationBlock: complete({ number: 10n, hash: location.blockHash }), operation: complete({ executed: true }), utxo: complete({ exists: true, owner: request.outputs[0]!.owner, commitment: request.outputs[0]!.commitment }) };
  const keyPort = { getKey: async () => hexToBytes(vector.expected.receipts[0]!.recipientPrivateKey) };
  return { observed, state, keyPort, owner: request.outputs[0]!.owner };
}
it.each(vectors.filter(v => v.input.outputs.length > 0))("independently receives $id without a LocalDraft", async vector => {
  const f = fixture(vector);
  const result = await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint);
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error("receipt rejected");
  expect(result.operationId).toBe(vector.expected.operationId);
  expect(result.utxo).toMatchObject({ id: vector.expected.outputIds[0]!.hash, owner: f.owner, commitment: f.observed.request.outputs[0]!.commitment, opening: { amount: BigInt(vector.expected.receipts[0]!.value), blinding: BigInt(vector.expected.receipts[0]!.blinding) } });
  expect(result.creationCheckpoint).toEqual({ number: 10n, hash: hash("10"), mode: "finalized" });
});

it("matches reordered RPC output arrays by outputIndex", async () => {
  const f = fixture();
  f.observed.outputLogs.reverse();
  expect((await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint)).status).toBe("available");
});
type Fixture = ReturnType<typeof fixture>;
const cases: [string, (f: Fixture) => void, string, string][] = [
  ["missing output 0", f => { f.observed.outputLogs.shift(); }, "unknown", "MISSING_OUTPUT"],
  ["missing output 1", f => { f.observed.outputLogs.pop(); }, "unknown", "MISSING_OUTPUT"],
  ["duplicate output", f => { f.observed.outputLogs.push(f.observed.outputLogs[0]!); }, "inconsistent", "OPERATION_BINDING"],
  ["reordered chain positions", f => { f.observed.outputLogs[0]!.logIndex = 2; f.observed.outputLogs[1]!.logIndex = 1; }, "inconsistent", "LOG_POSITION"],
  ["wrong output id", f => { f.observed.outputLogs[1]!.outputId = hash("ff"); }, "inconsistent", "OPERATION_BINDING"],
  ["missing success", f => { delete f.observed.success; }, "unknown", "MISSING_SUCCESS"],
  ["changed creation hash", f => { f.observed.success!.blockHash = hash("ff"); }, "inconsistent", "CHECKPOINT"],
  ["changed creation height", f => { f.observed.success!.blockNumber = 11n; }, "inconsistent", "CHECKPOINT"],
  ["creation at checkpoint height with another hash", f => {
    f.observed.success!.blockNumber = checkpoint.number;
    f.state.creationBlock = complete({ number: checkpoint.number, hash: f.observed.success!.blockHash });
  }, "inconsistent", "CHECKPOINT"],
  ["missing creation history", f => { f.state.creationBlock = { complete: false, reason: "GAP" }; }, "unknown", "HISTORY_UNAVAILABLE"],
  ["creation header bound to another checkpoint", f => { f.state.creationBlock = { complete: true, blockHash: hash("ff"), value: { number: 10n, hash: hash("10") } }; }, "unknown", "CHECKPOINT"],
  ["different transaction", f => { f.observed.outputLogs[1]!.transactionHash = hash("ff"); }, "inconsistent", "LOG_POSITION"],
  ["malformed packet", f => { f.observed.request.outputs[0]!.packet = "0x01"; }, "inconsistent", "INVALID_REQUEST"],
  ["wrong owner", f => { f.owner = zeroAddress; }, "inconsistent", "OWNER"],
  ["failed state observation", f => { f.state.utxo = { complete: false, reason: "RPC" }; }, "unknown", "HISTORY_UNAVAILABLE"],
  ["wrong state checkpoint", f => { f.state.utxo = { complete: true, blockHash: hash("ff"), value: { exists: true } }; }, "unknown", "CHECKPOINT"],
  ["not executed", f => { f.state.operation = complete({ executed: false }); }, "inconsistent", "UTXO_STATE"],
  ["absent UTXO", f => { f.state.utxo = complete({ exists: false }); }, "inconsistent", "UTXO_STATE"],
  ["missing owner state", f => { f.state.utxo = complete({ exists: true }); }, "unknown", "HISTORY_UNAVAILABLE"],
  ["spent without consuming operation", f => { if (f.state.utxo.complete) f.state.utxo.value.consumedBy = hash("ff"); }, "unknown", "HISTORY_UNAVAILABLE"],
  ["key access error", f => { f.keyPort.getKey = async () => { throw new Error("secret detail"); }; }, "unknown", "KEY_UNAVAILABLE"],
  ["wrong receipt key", f => { f.keyPort.getKey = async () => new Uint8Array(32).fill(1); }, "inconsistent", "DECRYPT"],
];
it.each(cases)("rejects %s without available balance", async (_, mutate, status, reason) => {
  const f = fixture(); mutate(f);
  expect(await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint)).toEqual({ status, reason });
});
it("validates consuming operation ID, owner and input membership", async () => {
  const f = fixture();
  const consumed: OperationRequest = { ...f.observed.request, kind: 2, owner: f.owner, inputIds: [f.observed.outputLogs[0]!.outputId], outputs: [], w: 1n, destination: f.owner };
  if (!f.state.utxo.complete) throw new Error("fixture");
  f.state.utxo.value.consumedBy = operationId(f.state.context, consumed);
  f.state.consumingOperation = complete({ executed: true, operation: consumed });
  expect((await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint)).status).toBe("spent");
  consumed.inputIds = [hash("dd")];
  f.state.utxo.value.consumedBy = operationId(f.state.context, consumed);
  expect(await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint)).toEqual({ status: "inconsistent", reason: "CONSUMPTION" });
});
it("checks packet bytes in the output event against the public request", async () => {
  const f = fixture();
  Object.assign(f.observed.outputLogs[0]!, { output: { ...f.observed.request.outputs[0]!, packet: `0x${"00".repeat(112)}` } });
  expect(await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint)).toEqual({ status: "inconsistent", reason: "OPERATION_BINDING" });
});
type AbiLog = { topics: [Hex, ...Hex[]]; data: Hex; name: string; args: (string | string[])[] };
const abiVectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/abi-observation.json", import.meta.url), "utf8")) as { id: string; input: { operationCase: string; logs?: AbiLog[] } }[];
const operationVectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/operation.json", import.meta.url), "utf8")) as Vector[];
it.each(abiVectors.filter(v => ["VEC-06-LOG-MISSING", "VEC-06-LOG-ORDER", "VEC-06-LOG-OUTPUT-ID", "VEC-06-LOG-PACKET"].includes(v.id)))("rejects observation vector $id before decryption", async vector => {
  const f = fixture();
  const base = operationVectors.find(v => v.id === vector.input.operationCase)!;
  f.observed.request = { ...base.input, d: BigInt(base.input.d), w: BigInt(base.input.w), outputs: base.input.outputs.map(o => ({ owner: o.owner, commitment: { x: BigInt(o.Cx), y: BigInt(o.Cy) }, receiptFormat: 1, packet: o.packet })) };
  const location = f.observed.success!;
  f.observed.outputLogs = [];
  delete f.observed.success;
  vector.input.logs!.forEach((log, logIndex) => {
    const args = log.args as string[];
    if (log.name === "OperationSucceeded") f.observed.success = { ...location, logIndex, operationId: args[0] as Hex };
    if (log.name === "OutputCreated") {
      const decoded = decodeEventLog({ abi: parseAbi(["event OutputCreated(address indexed owner, bytes32 indexed utxoId, bytes32 indexed operationId, uint256 outputIndex, uint256 Cx, uint256 Cy, uint8 receiptFormat, bytes packet)"]), topics: log.topics, data: log.data }).args;
      f.observed.outputLogs.push({ ...location, logIndex, operationId: decoded.operationId, outputId: decoded.utxoId, outputIndex: Number(decoded.outputIndex), output: { owner: decoded.owner, commitment: { x: decoded.Cx, y: decoded.Cy }, receiptFormat: decoded.receiptFormat as 1, packet: decoded.packet } });
    }
  });
  f.owner = f.observed.request.outputs[0]!.owner;
  f.state.utxo = complete({ exists: true, owner: f.owner, commitment: f.observed.request.outputs[0]!.commitment });
  const result = await inspectReceipt(f.observed, 0, f.owner, f.keyPort, f.state, checkpoint);
  expect(result).toEqual({ status: vector.id === "VEC-06-LOG-MISSING" ? "unknown" : "inconsistent", reason: vector.id === "VEC-06-LOG-MISSING" ? "MISSING_SUCCESS" : vector.id === "VEC-06-LOG-ORDER" ? "LOG_POSITION" : "OPERATION_BINDING" });
});
