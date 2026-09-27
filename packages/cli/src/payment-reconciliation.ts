import { hexToBytes, parseEventLogs } from "viem";
import type { PublicClient } from "viem";
import { inspectReceipt } from "@confidential-utxo/core";
import { adapterAbi } from "@confidential-utxo/uniswap";
import type { FinalizedHistory, ReconciliationPorts, SavedReservation,
  OperationRef, PaymentDeployment, Scope } from "@confidential-utxo/uniswap";
import type { Context, ReceiptFailure } from "@confidential-utxo/core";
import { OwnerService } from "./owner.js";
import { readOwnerState } from "./state.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unknownReceipt = (): ReceiptFailure => ({ status: "unknown", reason: "MISSING_SUCCESS" });

export type CliReconciliationInput = { ownerService: OwnerService; passphrase: Uint8Array;
  context: Context; deployment: PaymentDeployment; scope: Scope; chainRpc: PublicClient };

export function createCliReconciliation(input: CliReconciliationInput): ReconciliationPorts {
  return { expectedChainId: input.context.chainId,
    async readFinalized(ref: OperationRef, saved: SavedReservation) {
      const { history } = await input.ownerService.verifiedOnline(input.passphrase);
      const point = await history.getFinalizedCheckpoint();
      if (!point || point.mode !== input.context.finalityMode ||
        await input.chainRpc.getChainId() !== Number(input.context.chainId)) {
        throw new Error("PAYMENT_CHECKPOINT_UNAVAILABLE");
      }
      const header = await input.chainRpc.getBlock({ blockNumber: point.number });
      if (!header.hash || !same(header.hash, point.hash)) throw new Error("PAYMENT_CHECKPOINT_REORG");
      const base: FinalizedHistory = { chainId: input.context.chainId,
        deploymentId: input.scope.deploymentId, checkpoint: point, blockHash: point.hash as never,
        finalized: true, canonical: true, rpcConsistent: true };
      const rawLogs = await input.chainRpc.getLogs({ address: input.deployment.adapter,
        fromBlock: input.context.deploymentBlock, toBlock: point.number });
      const events = parseEventLogs({ abi: adapterAbi, eventName: "PaymentSucceeded", logs: rawLogs })
        .filter(log => same(log.args.paymentId, ref.paymentId ?? "") &&
          same(log.args.operationId, ref.operationId) && same(log.args.owner, ref.scope.owner));
      if (events.length !== 1) return { history: base, receipt: unknownReceipt() };
      const event = events[0]!;
      const receipt = await input.chainRpc.getTransactionReceipt({ hash: event.transactionHash });
      if (receipt.status !== "success" || !same(receipt.blockHash, event.blockHash) ||
        receipt.blockNumber > point.number) return { history: base, receipt: unknownReceipt() };
      const receiptEvents = parseEventLogs({ abi: adapterAbi, eventName: "PaymentSucceeded",
        logs: receipt.logs.filter(log => same(log.address, input.deployment.adapter)) });
      if (receiptEvents.length !== 1 || !same(receiptEvents[0]!.args.paymentId, event.args.paymentId)) {
        return { history: base, receipt: unknownReceipt() };
      }
      const state = await readOwnerState(input.ownerService.config.dir, input.passphrase,
        input.context, input.scope.owner);
      const terms = state.connection?.payments[ref.operationId]?.terms;
      if (!terms || !same(event.args.token, terms.token) || !same(event.args.recipient, terms.recipient) ||
        event.args.ethAmount !== terms.ethAmount || event.args.minAmountOut !== terms.minAmountOut ||
        event.args.deadline !== terms.deadline) return { history: base, receipt: unknownReceipt() };
      const operationRows = await history.getOperations(input.context.deploymentBlock, point);
      if (!operationRows.complete || !same(operationRows.blockHash, point.hash)) {
        throw new Error("PAYMENT_HISTORY_UNAVAILABLE");
      }
      const observed = operationRows.value.find(item => same(item.success?.operationId ?? "", ref.operationId));
      if (!observed?.success || !same(observed.success.transactionHash, event.transactionHash)) {
        return { history: base, receipt: unknownReceipt() };
      }
      const operation = await history.getOperationSuccess(ref.operationId, point);
      const utxo = await history.getUtxo(saved.record.inputId, point);
      const changeId = state.operations[ref.operationId]?.fixed.outputIds[0];
      if (!changeId) return { history: base, receipt: unknownReceipt() };
      const change = await history.getUtxo(changeId, point);
      const creationBlock = await history.getCanonicalHeader(observed.success.blockNumber, point);
      if (!operation.complete || !utxo.complete || !change.complete || !creationBlock.complete ||
        !same(operation.blockHash, point.hash) || !same(utxo.blockHash, point.hash) ||
        !same(change.blockHash, point.hash) || !same(creationBlock.blockHash, point.hash)) {
        throw new Error("PAYMENT_HISTORY_UNAVAILABLE");
      }
      const consumingOperation = change.value.consumedBy
        ? await history.getOperationSuccess(change.value.consumedBy, point) : undefined;
      const keys = state.receiptKeys.map(key => hexToBytes(key.secretKey));
      let received;
      try {
        received = await inspectReceipt(observed, 0, input.scope.owner, {
          getKey: async () => keys[0]!, getKeys: async () => keys,
        }, { context: input.context, creationBlock, operation, utxo: change,
          ...(consumingOperation ? { consumingOperation } : {}) }, point);
      } finally { keys.forEach(key => key.fill(0)); }
      const finalizedHistory: FinalizedHistory = {
        ...base, blockHash: receipt.blockHash as never,
        canonical: same(creationBlock.value.hash, receipt.blockHash),
        adapter: { blockHash: receipt.blockHash as never, paymentId: event.args.paymentId as never,
          operationId: event.args.operationId as never, owner: event.args.owner as never,
          amountOut: event.args.amountOut },
        pool: { blockHash: observed.success.blockHash as never,
          operationId: observed.success.operationId as never, inputId: saved.record.inputId,
          changeOutputId: changeId as never },
        input: { blockHash: receipt.blockHash as never, inputId: saved.record.inputId,
          consumed: same(utxo.value.consumedBy ?? "", ref.operationId) },
        change: { blockHash: receipt.blockHash as never, outputId: changeId as never,
          owner: change.value.owner as never },
      };
      return { history: finalizedHistory, receipt: received };
    },
  };
}
