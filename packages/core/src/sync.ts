import type { Address, Hex } from "viem";
import { operationId, outputId, validateOperationShape } from "./encoding.js";
import { inspectReceipt } from "./receipt.js";
import type { Checkpoint, Context, HistoryPort, Observation, ObservedOperation, OperationSuccess, OwnedUtxo, ReceiptKeyPort, UtxoState } from "./types.js";

export type StaleSnapshot = { status: "stale"; checkpoint: Checkpoint; utxos: OwnedUtxo[] };
export type SyncResult =
  | { status: "complete"; checkpoint: Checkpoint; utxos: OwnedUtxo[]; availableWei: bigint }
  | { status: "unconfirmed"; checkpoint?: Checkpoint; previous?: StaleSnapshot; reason: "NO_FINALITY" | "CONTEXT" | "INCOMPLETE_HISTORY" | "INCONSISTENT_HISTORY" | "RECEIPT" | "RPC" };
export type SyncPorts = { history: HistoryPort; keys: ReceiptKeyPort; owners: Address[] };
type Reason = Extract<SyncResult, { status: "unconfirmed" }>["reason"];
class SyncFailure extends Error { constructor(readonly reason: Reason) { super(reason); } }
function reject(reason: Reason): never { throw new SyncFailure(reason); }
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const position = (n: number) => Number.isSafeInteger(n) && n >= 0;
function value<T>(observation: Observation<T>, point: Checkpoint): T {
  if (!observation.complete || !equal(observation.blockHash, point.hash)) reject("INCOMPLETE_HISTORY");
  return structuredClone(observation.value);
}
function sameContext(a: Context, b: Context): boolean {
  return a.chainId === b.chainId && equal(a.pool, b.pool) && a.deploymentBlock === b.deploymentBlock &&
    equal(a.verifier, b.verifier) && equal(a.parametersHash, b.parametersHash) && a.finalityMode === b.finalityMode;
}
function stale(previous?: SyncResult): StaleSnapshot | undefined {
  const old = previous?.status === "complete" ? previous : previous?.previous;
  if (!old) return undefined;
  return { status: "stale", checkpoint: structuredClone(old.checkpoint), utxos: old.utxos.map(u => ({ ...structuredClone(u), status: "unknown" })) };
}

/** Rebuilds from all Pool history. Adapter completeness and canonical ancestry are trust boundaries. */
export async function synchronize(context: Context, ports: SyncPorts, previous?: SyncResult): Promise<SyncResult> {
  const expected = structuredClone(context);
  const owners = new Set(ports.owners.map(owner => owner.toLowerCase()));
  const old = stale(previous);
  const { history, keys } = ports;
  let point: Checkpoint | undefined;
  try {
    if (owners.size === 0) reject("CONTEXT");
    const finalized = await history.getFinalizedCheckpoint();
    if (!finalized || finalized.mode !== expected.finalityMode || finalized.number < expected.deploymentBlock) reject("NO_FINALITY");
    point = structuredClone(finalized!);
    if (!sameContext(expected, value(await history.getContext(point), point))) reject("CONTEXT");
    const operations = value(await history.getOperations(expected.deploymentBlock, point), point);
    operations.sort((a, b) => {
      if (!a.success || !b.success) return 0;
      return a.success.blockNumber < b.success.blockNumber ? -1 : a.success.blockNumber > b.success.blockNumber ? 1 :
        a.success.transactionIndex - b.success.transactionIndex || a.success.logIndex - b.success.logIndex;
    });
    const headers = new Map<bigint, { number: bigint; hash: Hex }>();
    const successes = new Map<string, OperationSuccess>();
    const created = new Map<string, { observed: ObservedOperation; index: number; consumedBy?: Hex }>();
    let precedingSuccess: { blockNumber: bigint; logIndex: number } | undefined;
    const positions = new Set<string>();
    const transactions = new Map<string, string>();
    const transactionPositions = new Map<string, string>();
    for (const observed of operations) {
      validateOperationShape(observed.request);
      const success = observed.success;
      if (!success) reject("INCOMPLETE_HISTORY");
      const event = success!;
      const id = operationId(expected, observed.request);
      if (!equal(id, event.operationId) || successes.has(id.toLowerCase())) reject("INCONSISTENT_HISTORY");
      if (event.blockNumber < expected.deploymentBlock || event.blockNumber > point.number) reject("INCONSISTENT_HISTORY");
      let header = headers.get(event.blockNumber);
      if (!header) {
        header = value(await history.getCanonicalHeader(event.blockNumber, point), point);
        headers.set(event.blockNumber, header);
      }
      if (header.number !== event.blockNumber || !equal(header.hash, event.blockHash) || (header.number === point.number && !equal(header.hash, point.hash))) reject("INCONSISTENT_HISTORY");
      const inputs = observed.inputLogs ?? [];
      if (inputs.length !== observed.request.inputIds.length || observed.outputLogs.length !== observed.request.outputs.length) reject("INCOMPLETE_HISTORY");
      for (const log of [...inputs, ...observed.outputLogs, event]) {
        if (!position(log.transactionIndex) || !position(log.logIndex) || log.blockNumber !== event.blockNumber || !equal(log.blockHash, event.blockHash) || !equal(log.transactionHash, event.transactionHash) || log.transactionIndex !== event.transactionIndex || !equal(log.operationId, id)) reject("INCONSISTENT_HISTORY");
        const logPosition = `${log.blockNumber}:${log.logIndex}`;
        if (positions.has(logPosition)) reject("INCONSISTENT_HISTORY");
        positions.add(logPosition);
      }
      const firstLog = event.logIndex - inputs.length - observed.request.outputs.length;
      if (precedingSuccess?.blockNumber === event.blockNumber && firstLog <= precedingSuccess.logIndex) reject("INCONSISTENT_HISTORY");
      precedingSuccess = event;
      const txPosition = `${event.blockNumber}:${event.transactionIndex}`;
      const txHash = event.transactionHash.toLowerCase();
      if ((transactions.has(txHash) && transactions.get(txHash) !== txPosition) || (transactionPositions.has(txPosition) && transactionPositions.get(txPosition) !== txHash)) reject("INCONSISTENT_HISTORY");
      transactions.set(txHash, txPosition);
      transactionPositions.set(txPosition, txHash);
      inputs.sort((a, b) => a.logIndex - b.logIndex);
      for (let i = 0; i < inputs.length; i++) {
        const log = inputs[i]!;
        const inputId = observed.request.inputIds[i]!;
        if (!equal(log.inputId, inputId) || log.logIndex !== event.logIndex - observed.request.outputs.length - inputs.length + i) reject("INCONSISTENT_HISTORY");
        const input = created.get(inputId.toLowerCase());
        if (!input || input.consumedBy || !equal(input.observed.request.outputs[input.index]!.owner, observed.request.owner)) reject("INCONSISTENT_HISTORY");
        input.consumedBy = id;
      }
      for (let i = 0; i < observed.request.outputs.length; i++) {
        const output = observed.request.outputs[i]!;
        const matches = observed.outputLogs.filter(log => log.outputIndex === i);
        const log = matches[0];
        if (matches.length !== 1 || !log || !equal(log.outputId, outputId(id, i)) || log.logIndex !== event.logIndex - observed.request.outputs.length + i || !equal(log.output.owner, output.owner) || log.output.commitment.x !== output.commitment.x || log.output.commitment.y !== output.commitment.y || log.output.receiptFormat !== output.receiptFormat || !equal(log.output.packet, output.packet)) reject("INCONSISTENT_HISTORY");
        const outputKey = outputId(id, i).toLowerCase();
        if (created.has(outputKey)) reject("INCONSISTENT_HISTORY");
        created.set(outputKey, { observed, index: i });
      }
      const state = value(await history.getOperationSuccess(id, point), point);
      if (!state.executed || (state.operation && !equal(operationId(expected, state.operation), id))) reject("INCONSISTENT_HISTORY");
      successes.set(id.toLowerCase(), { executed: true, operation: observed.request });
    }
    const bound = <T>(v: T): Observation<T> => ({ complete: true, blockHash: point!.hash, value: v });
    const utxos: OwnedUtxo[] = [];
    for (const [id, entry] of created) {
      const { observed, index, consumedBy } = entry;
      const output = observed.request.outputs[index]!;
      const state: UtxoState = value(await history.getUtxo(id as Hex, point), point);
      if (!state.exists || !state.owner || !state.commitment || !equal(state.owner, output.owner) || state.commitment.x !== output.commitment.x || state.commitment.y !== output.commitment.y || (state.consumedBy?.toLowerCase() !== consumedBy?.toLowerCase())) reject("INCONSISTENT_HISTORY");
      if (!owners.has(output.owner.toLowerCase())) continue;
      const receipt = await inspectReceipt(observed, index, output.owner, keys, {
        context: expected,
        creationBlock: bound(headers.get(observed.success!.blockNumber)!),
        operation: bound(successes.get(observed.success!.operationId.toLowerCase())!),
        utxo: bound(state),
        ...(consumedBy ? { consumingOperation: bound(successes.get(consumedBy.toLowerCase())!) } : {}),
      }, point);
      if (receipt.status !== "available" && receipt.status !== "spent") reject("RECEIPT");
      if ("utxo" in receipt) utxos.push(receipt.utxo);
    }
    // Recheck canonicality after asynchronous key access and all state reads.
    const end = value(await history.getCanonicalHeader(point.number, point), point);
    if (end.number !== point.number || !equal(end.hash, point.hash)) reject("INCONSISTENT_HISTORY");
    return { status: "complete", checkpoint: point, utxos, availableWei: utxos.reduce((sum, coin) => sum + (coin.status === "available" ? coin.opening.amount : 0n), 0n) };
  } catch (error) {
    return { status: "unconfirmed", ...(point ? { checkpoint: point } : {}), ...(old ? { previous: old } : {}), reason: error instanceof SyncFailure ? error.reason : "RPC" };
  }
}
