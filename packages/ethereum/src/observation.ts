import { decodeErrorResult, TransactionReceiptNotFoundError } from "viem";
import type { Hex, PublicClient } from "viem";
import { operationId } from "@confidential-utxo/core";
import type { AttemptObservation, HistoryPort, OperationSuccessEvidence, Observation } from "@confidential-utxo/core";
import { poolAbi } from "./abi.js";
import { readWithPolicy } from "./rpc.js";
import type { RpcPolicy } from "./rpc.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bound = <T>(result: Observation<T>, hash: Hex): result is Extract<Observation<T>, { complete: true }> =>
  result.complete && same(result.blockHash, hash);
const historyFailure = <T>(result: Observation<T>) => result.complete || result.reason === "HASH_MISMATCH" ?
  "reorg" as const : "uncertain" as const;

export function decodePoolFailure(data: Hex): { name: string; args: unknown[] } | { name: "UNKNOWN" } {
  try {
    const decoded = decodeErrorResult({ abi: poolAbi, data });
    return { name: decoded.errorName, args: [...(decoded.args ?? [])] };
  } catch { return { name: "UNKNOWN" }; }
}

export async function observeAttempt(history: HistoryPort, client: PublicClient, id: Hex, txHash: Hex,
  policy: RpcPolicy): Promise<{ observation: AttemptObservation;
    gas?: { gasUsed: bigint; effectiveGasPrice: bigint } }> {
  const observation: AttemptObservation = { txHash, outer: "unconfirmed", operation: "unconfirmed" };
  let gas: { gasUsed: bigint; effectiveGasPrice: bigint } | undefined;
  try {
    const receipt = await readWithPolicy(async () => {
      try { return await client.getTransactionReceipt({ hash: txHash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    }, policy);
    if (receipt === null) observation.outer = "pending";
    else {
      gas = { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
      const header = await readWithPolicy(() => client.getBlock({ blockNumber: receipt.blockNumber }), policy);
      if (!header.hash || !same(header.hash, receipt.blockHash)) observation.historyStatus = "reorg";
      else {
        observation.outer = receipt.status === "success" ? "success" : "failed";
        observation.blockNumber = receipt.blockNumber;
        observation.blockHash = receipt.blockHash;
        if (receipt.status !== "success") observation.failure = "OUTER_REVERT";
      }
    }
  } catch { observation.outer = "unconfirmed"; }

  try {
    const point = await history.getFinalizedCheckpoint();
    if (!point) {
      observation.historyStatus = "uncertain";
      return { observation, ...(gas ? { gas } : {}) };
    }
    const contextResult = await history.getContext(point);
    if (!bound(contextResult, point.hash)) {
      observation.historyStatus = historyFailure(contextResult);
      return { observation, ...(gas ? { gas } : {}) };
    }
    const context = contextResult.value;
    const [record, operations] = await Promise.all([
      history.getOperationSuccess(id, point), history.getOperations(context.deploymentBlock, point),
    ]);
    if (!bound(record, point.hash) || !bound(operations, point.hash)) {
      observation.historyStatus = !bound(record, point.hash) ? historyFailure(record) : historyFailure(operations);
      return { observation, ...(gas ? { gas } : {}) };
    }
    const matching = operations.value.filter(item => item.success && same(item.success.operationId, id));
    if (!record.value.executed && matching.length === 0) {
      // A prior checkpoint may have established success; this checkpoint does not.
      observation.historyStatus = "uncertain";
      return { observation, ...(gas ? { gas } : {}) };
    }
    if (!record.value.executed || matching.length !== 1 || !matching[0]?.success ||
        !same(operationId(context, matching[0].request), id) ||
        (record.value.operation && !same(operationId(context, record.value.operation), id))) {
      observation.historyStatus = "uncertain";
      return { observation, ...(gas ? { gas } : {}) };
    }
    const event = matching[0];
    const success = event.success!;
    const header = await history.getCanonicalHeader(success.blockNumber, point);
    if (!bound(header, point.hash) || !same(header.value.hash, success.blockHash)) {
      observation.historyStatus = header.complete ? "reorg" :
        header.reason === "HASH_MISMATCH" ? "reorg" : "uncertain";
      return { observation, ...(gas ? { gas } : {}) };
    }
    const evidence: OperationSuccessEvidence = { context, checkpoint: point, event, record, header };
    observation.evidence = evidence;
    observation.operation = "executed";
    delete observation.historyStatus;
  } catch { observation.historyStatus = "uncertain"; }
  return { observation, ...(gas ? { gas } : {}) };
}
