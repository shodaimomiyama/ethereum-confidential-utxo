import { inspectReceipt, type Observation, type ReceiptFailure } from '@confidential-utxo/core';
import { readWithPolicy, type RpcConnection, type VerifiedDeployment } from '@confidential-utxo/ethereum';
import { adapterAbi, assertWithdrawalBinding, paymentDigest, type Bytes32, type FinalizedHistory,
  type PaymentTerms, type ReconciliationPorts } from '@confidential-utxo/uniswap';
import { parseEventLogs } from 'viem';
import { createScopedEthereumBridge } from './ethereum.js';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { openPaymentPrivateRecord } from './payment-record.js';
import type { PreparationDeployment } from './payment-preparation.js';
import { createWorkerReceiptKeyPort } from './receipt-worker.js';

export interface BrowserPaymentReconciliationDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly verified: VerifiedDeployment;
  readonly deployment: PreparationDeployment;
  readonly resolveVerified: (id: OperationContext['scope']['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) => PreparationDeployment | undefined;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fingerprint = (value: unknown): string => JSON.stringify(value,
  (_key, item: unknown) => typeof item === 'bigint' ? item.toString()
    : item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const unknownReceipt = (): ReceiptFailure => ({ status: 'unknown', reason: 'MISSING_SUCCESS' });

/** Collects one finalized Pay history; #55 decides success and change usability from this evidence. */
export function createBrowserPaymentReconciliation(deps: BrowserPaymentReconciliationDependencies): ReconciliationPorts {
  const { context, rpc } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const verified = structuredClone(deps.verified);
  const deployment = { ...deps.deployment };
  const pinnedVerified = fingerprint(verified);
  const pinnedDeployment = fingerprint(deployment);
  const client = rpc.client;
  function check(): void {
    context.check();
    if (!sameScope(scope, context.scope) || epoch !== context.epoch || client !== rpc.client
      || fingerprint(deps.verified) !== pinnedVerified || fingerprint(deps.deployment) !== pinnedDeployment
      || fingerprint(deps.resolveVerified(scope.deploymentId)) !== pinnedVerified
      || fingerprint(deps.resolveDeployment(scope.deploymentId)) !== pinnedDeployment
      || rpc.mode !== verified.context.finalityMode || deployment.chainId !== verified.context.chainId
      || deployment.chainId !== BigInt(verified.manifest.chainId)
      || !same(deployment.pool, verified.context.pool) || !same(deployment.pool, verified.manifest.pool.address)) {
      throw new Error('SCOPE_CHANGED');
    }
  }
  check();
  const { history } = createScopedEthereumBridge({ context, rpc, resolveVerified: deps.resolveVerified });
  const keys = createWorkerReceiptKeyPort(context);
  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    check();
    try { return await read(); } finally { check(); }
  }
  const rpcRead = <T>(read: () => Promise<T>) => guarded(() => readWithPolicy(read, rpc.policy));
  return {
    expectedChainId: deployment.chainId,
    async readFinalized(refInput, savedInput) {
      check();
      const ref = structuredClone(refInput);
      const saved = structuredClone(savedInput);
      if (!sameScope(ref.scope, scope) || !sameScope(saved.record.scope, scope)
        || saved.record.kind !== 'pay' || !same(ref.operationId, saved.record.operationId)
        || !same(ref.paymentId ?? '', saved.record.paymentId)) throw new Error('INVALID_PAYMENT_RECORD');
      const record = saved.record;
      const plain = await guarded(() => openPaymentPrivateRecord(context.recordKey(), {
        deploymentId: scope.deploymentId, owner: scope.owner, chainId: deployment.chainId,
        pool: deployment.pool, recordId: record.recordId, revision: saved.revision,
      }, record));
      const draft = plain.creationInputs;
      const terms = plain.intendedAuthorization.payment?.message as PaymentTerms | undefined;
      if (!terms || fingerprint(draft.context) !== fingerprint(verified.context)
        || !same(terms.owner, scope.owner) || !same(terms.operationId, ref.operationId)
        || !same(paymentDigest(terms, deployment.chainId, deployment.adapter), record.paymentId)
        || terms.deadline !== record.deadline || !same(terms.token, deployment.token)
        || draft.outputIds.length !== 1 || draft.request.inputIds.length !== 1
        || !same(draft.request.inputIds[0]!, record.inputId)) throw new Error('INVALID_PAYMENT_RECORD');
      assertWithdrawalBinding(draft, terms, deployment);
      const changeId = draft.outputIds[0]!;
      const point = await guarded(() => history.getFinalizedCheckpoint());
      if (!point || point.mode !== verified.context.finalityMode || point.number < verified.context.deploymentBlock
        || BigInt(await rpcRead(() => client.getChainId())) !== deployment.chainId) {
        throw new Error('PAYMENT_CHECKPOINT_UNAVAILABLE');
      }
      async function anchor(): Promise<void> {
        const header = await rpcRead(() => client.getBlock({ blockNumber: point!.number }));
        if (!header.hash || !same(header.hash, point!.hash)) throw new Error('PAYMENT_CHECKPOINT_REORG');
      }
      await anchor();
      function complete<T>(observation: Observation<T>): T {
        if (!observation.complete || !same(observation.blockHash, point!.hash)) throw new Error('PAYMENT_HISTORY_UNAVAILABLE');
        return observation.value;
      }
      const base: FinalizedHistory = { chainId: deployment.chainId, deploymentId: scope.deploymentId,
        checkpoint: point, blockHash: point.hash as Bytes32, finalized: true, canonical: true, rpcConsistent: true };
      const unknown = () => ({ history: base, receipt: unknownReceipt() });
      const events: ReturnType<typeof parsePayments> = [];
      const step = rpc.policy.chunkBlocks;
      if (step < 1n) throw new Error('PAYMENT_HISTORY_UNAVAILABLE');
      for (let from = verified.context.deploymentBlock; from <= point.number; from += step) {
        const to = from + step - 1n < point.number ? from + step - 1n : point.number;
        const logs = await rpcRead(() => client.getLogs({ address: deployment.adapter, fromBlock: from, toBlock: to }));
        events.push(...parsePayments(logs.filter(log => same(log.address, deployment.adapter))));
      }
      const matching = events.filter(log => same(log.args.paymentId, record.paymentId));
      if (matching.length !== 1) return unknown();
      const event = matching[0]!;
      if (event.removed || !same(event.args.operationId, ref.operationId) || !same(event.args.owner, scope.owner)
        || !same(event.args.token, terms.token) || !same(event.args.recipient, terms.recipient)
        || event.args.ethAmount !== terms.ethAmount || event.args.minAmountOut !== terms.minAmountOut
        || event.args.deadline !== terms.deadline || event.args.amountOut < terms.minAmountOut
        || event.args.amountOut <= 0n || event.blockNumber > point.number) return unknown();
      const tx = await rpcRead(() => client.getTransactionReceipt({ hash: event.transactionHash }));
      const txEvents = parsePayments(tx.logs.filter(log => same(log.address, deployment.adapter)));
      if (tx.status !== 'success' || !same(tx.transactionHash, event.transactionHash)
        || !same(tx.blockHash, event.blockHash) || tx.blockNumber !== event.blockNumber
        || txEvents.length !== 1 || fingerprint(txEvents[0]!.args) !== fingerprint(event.args)
        || txEvents[0]!.logIndex !== event.logIndex) return unknown();
      const rows = complete(await guarded(() => history.getOperations(verified.context.deploymentBlock, point)));
      const observedRows = rows.filter(row => same(row.success?.operationId ?? '', ref.operationId));
      if (observedRows.length !== 1) return unknown();
      const observed = observedRows[0]!;
      const success = observed.success!;
      if (!same(success.transactionHash, event.transactionHash) || !same(success.blockHash, event.blockHash)
        || success.blockNumber !== event.blockNumber || fingerprint(observed.request) !== fingerprint(draft.request)) return unknown();
      const operation = await guarded(() => history.getOperationSuccess(ref.operationId, point));
      const input = complete(await guarded(() => history.getUtxo(record.inputId, point)));
      const change = await guarded(() => history.getUtxo(changeId, point));
      const creationBlock = await guarded(() => history.getCanonicalHeader(success.blockNumber, point));
      const op = complete(operation);
      const output = complete(change);
      const creation = complete(creationBlock);
      if (!op.executed || !op.operation || fingerprint(op.operation) !== fingerprint(draft.request)
        || !input.exists || !same(input.owner ?? '', scope.owner) || !same(input.consumedBy ?? '', ref.operationId)
        || !output.exists || !same(output.owner ?? '', scope.owner) || !same(creation.hash, event.blockHash)) return unknown();
      const consumingOperation = output.consumedBy
        ? await guarded(() => history.getOperationSuccess(output.consumedBy!, point)) : undefined;
      if (consumingOperation) complete(consumingOperation);
      const received = await guarded(() => inspectReceipt(observed, 0, scope.owner, keys, {
        context: verified.context, creationBlock, operation, utxo: change,
        ...(consumingOperation ? { consumingOperation } : {}),
      }, point));
      await anchor();
      const blockHash = event.blockHash as Bytes32;
      return { history: { ...base, blockHash,
        adapter: { blockHash, paymentId: record.paymentId, operationId: record.operationId,
          owner: scope.owner, amountOut: event.args.amountOut },
        pool: { blockHash: success.blockHash as Bytes32, operationId: record.operationId,
          inputId: record.inputId, changeOutputId: changeId as Bytes32 },
        input: { blockHash, inputId: record.inputId, consumed: true },
        change: { blockHash, outputId: changeId as Bytes32, owner: scope.owner },
      }, receipt: received };
    },
  };
}

function parsePayments(logs: Parameters<typeof parseEventLogs>[0]['logs']) {
  return parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded', logs, strict: true });
}
