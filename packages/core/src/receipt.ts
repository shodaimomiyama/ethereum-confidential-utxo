import { decryptReceipt } from "@confidential-utxo/crypto";
import { hexToBytes } from "viem";
import type { Address, Hex } from "viem";
import { operationId, outputId, receiptInfo, validateOperationShape } from "./encoding.js";
import type { Checkpoint, Context, Observation, ObservedOperation, OperationSuccess, OwnedUtxo, ReceiptKeyPort, UtxoState } from "./types.js";

export type ReceiptState = {
  context: Context;
  /** Canonical creation header observed in the history ending at the observation's blockHash. */
  creationBlock: Observation<{ number: bigint; hash: Hex }>;
  operation: Observation<OperationSuccess>;
  utxo: Observation<UtxoState>;
  consumingOperation?: Observation<OperationSuccess>;
};
export type ReceivedUtxo = {
  status: "available" | "spent";
  operationId: Hex;
  utxo: OwnedUtxo;
  creationCheckpoint: Checkpoint;
};
export type ReceiptFailure = {
  status: "inconsistent" | "unknown";
  reason: "INVALID_REQUEST" | "OUTPUT_INDEX" | "MISSING_SUCCESS" | "MISSING_OUTPUT" | "OPERATION_BINDING" | "LOG_POSITION" | "CHECKPOINT" | "HISTORY_UNAVAILABLE" | "OWNER" | "UTXO_STATE" | "CONSUMPTION" | "KEY_UNAVAILABLE" | "DECRYPT";
};
const fail = (status: ReceiptFailure["status"], reason: ReceiptFailure["reason"]): ReceiptFailure => ({ status, reason });
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const position = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Uses checkpoint-bound observations supplied by the history adapter; never uses sender secrets. */
export async function inspectReceipt(observed: ObservedOperation, outputIndex: number, expectedOwner: Address, keyPort: ReceiptKeyPort, stateAtCheckpoint: ReceiptState, checkpoint: Checkpoint): Promise<ReceivedUtxo | ReceiptFailure> {
  // Snapshot before the key port yields so concurrent sync cannot mix observations.
  const { request, success, outputLogs } = structuredClone(observed);
  const state = structuredClone(stateAtCheckpoint);
  const point = structuredClone(checkpoint);
  const { context } = state;
  try { validateOperationShape(request); }
  catch { return fail("inconsistent", "INVALID_REQUEST"); }
  if (!position(outputIndex) || !request.outputs[outputIndex]) return fail("inconsistent", "OUTPUT_INDEX");
  if (!success) return fail("unknown", "MISSING_SUCCESS");
  let id: Hex;
  try { id = operationId(context, request); }
  catch { return fail("inconsistent", "INVALID_REQUEST"); }
  if (!equal(id, success.operationId)) return fail("inconsistent", "OPERATION_BINDING");
  if (point.mode !== context.finalityMode || success.blockNumber < context.deploymentBlock || success.blockNumber > point.number) return fail("unknown", "CHECKPOINT");
  for (const observation of [state.creationBlock, state.operation, state.utxo]) {
    if (!observation.complete) return fail("unknown", "HISTORY_UNAVAILABLE");
    if (!equal(observation.blockHash, point.hash)) return fail("unknown", "CHECKPOINT");
  }
  const header = state.creationBlock;
  const operation = state.operation;
  const utxo = state.utxo;
  if (!header.complete || !operation.complete || !utxo.complete) return fail("unknown", "HISTORY_UNAVAILABLE");
  if (header.value.number !== success.blockNumber || !equal(header.value.hash, success.blockHash) || (success.blockNumber === point.number && !equal(success.blockHash, point.hash))) return fail("unknown", "CHECKPOINT");
  if (!position(success.transactionIndex) || !position(success.logIndex)) return fail("inconsistent", "LOG_POSITION");
  if (outputLogs.some(log => !position(log.outputIndex) || log.outputIndex >= request.outputs.length)) return fail("inconsistent", "OPERATION_BINDING");
  let previous = -1;
  for (let index = 0; index < request.outputs.length; index++) {
    const matches = outputLogs.filter(log => log.outputIndex === index);
    if (matches.length === 0) return fail("unknown", "MISSING_OUTPUT");
    if (matches.length !== 1) return fail("inconsistent", "OPERATION_BINDING");
    const log = matches[0]!;
    const expected = request.outputs[index]!;
    if (!log.output) return fail("unknown", "MISSING_OUTPUT");
    if (!equal(log.operationId, id) || !equal(log.output.owner, expected.owner) || log.output.commitment.x !== expected.commitment.x || log.output.commitment.y !== expected.commitment.y || log.output.receiptFormat !== expected.receiptFormat || !equal(log.output.packet, expected.packet)) return fail("inconsistent", "OPERATION_BINDING");
    if (!equal(log.outputId, outputId(id, index))) return fail("inconsistent", "OPERATION_BINDING");
    if (log.blockNumber !== success.blockNumber || !equal(log.blockHash, success.blockHash) || !equal(log.transactionHash, success.transactionHash) || log.transactionIndex !== success.transactionIndex || !position(log.logIndex) || log.logIndex <= previous || log.logIndex !== success.logIndex - request.outputs.length + index) return fail("inconsistent", "LOG_POSITION");
    previous = log.logIndex;
  }
  if (!operation.value.executed) return fail("inconsistent", "UTXO_STATE");
  if (operation.value.operation) {
    try { if (!equal(operationId(context, operation.value.operation), id)) return fail("inconsistent", "OPERATION_BINDING"); }
    catch { return fail("inconsistent", "OPERATION_BINDING"); }
  }
  const output = request.outputs[outputIndex]!;
  if (!equal(output.owner, expectedOwner)) return fail("inconsistent", "OWNER");
  if (!utxo.value.exists) return fail("inconsistent", "UTXO_STATE");
  if (!utxo.value.owner || !utxo.value.commitment) return fail("unknown", "HISTORY_UNAVAILABLE");
  if (!equal(utxo.value.owner, expectedOwner)) return fail("inconsistent", "OWNER");
  if (utxo.value.commitment.x !== output.commitment.x || utxo.value.commitment.y !== output.commitment.y) return fail("inconsistent", "UTXO_STATE");
  const receivedId = outputId(id, outputIndex);
  const consumedBy = utxo.value.consumedBy;
  if (consumedBy) {
    const consuming = state.consumingOperation;
    if (!consuming?.complete) return fail("unknown", "HISTORY_UNAVAILABLE");
    if (!equal(consuming.blockHash, point.hash)) return fail("unknown", "CHECKPOINT");
    if (!consuming.value.operation) return fail("unknown", "HISTORY_UNAVAILABLE");
    try {
      validateOperationShape(consuming.value.operation);
      if (!consuming.value.executed || !equal(operationId(context, consuming.value.operation), consumedBy) || !equal(consuming.value.operation.owner, expectedOwner) || !consuming.value.operation.inputIds.some(input => equal(input, receivedId))) return fail("inconsistent", "CONSUMPTION");
    } catch { return fail("inconsistent", "CONSUMPTION"); }
  }
  let key: Uint8Array;
  try { key = await keyPort.getKey(expectedOwner); }
  catch { return fail("unknown", "KEY_UNAVAILABLE"); }
  try {
    const opening = await decryptReceipt({ recipientPrivateKey: key, info: hexToBytes(receiptInfo(context, request, outputIndex)), packet: hexToBytes(output.packet), commitment: output.commitment });
    const status = consumedBy ? "spent" : "available";
    return { status, operationId: id, creationCheckpoint: { number: success.blockNumber, hash: success.blockHash, mode: point.mode }, utxo: { id: receivedId, owner: output.owner, opening, commitment: output.commitment, checkpoint: point, status, chainId: context.chainId, pool: context.pool } };
  } catch { return fail("inconsistent", "DECRYPT"); }
}
