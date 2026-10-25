import { inspectReceipt, operationId as coreOperationId, outputId,
  type HistoryPort, type ReceiptFailure, type ReceiptKeyPort, type ReceivedUtxo } from '@confidential-utxo/core';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import { inspectOperation, type OperationId, type OperationRef, type PaymentClient,
  type RecoveryPorts, type Scope, type SubmissionOutcome } from '@confidential-utxo/uniswap';
import type { Card, CardPhase, ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import type { OperationPortDependencies } from './operation-port.js';
import type { OperationContext, OperationResult } from './operations.js';
import type { RewardOperation } from './reward-operation.js';
import type { LiveReservationPort, LiveSavedReservation } from './reservations.js';

type Actions = Pick<OperationPortDependencies, 'recheck' | 'resumeOriginal' | 'retryAttempt' | 'receive'>;
type ActionArgs = Parameters<Actions['recheck']>;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
const complete = <T>(value: { complete: boolean; blockHash?: string; value?: T }, hash: string): value is {
  complete: true; blockHash: string; value: T;
} => value.complete && value.blockHash !== undefined && same(value.blockHash, hash);

export interface BrowserOperationActionDependencies {
  readonly snapshot: () => ViewState;
  readonly resolveVerified: (id: Scope['deploymentId']) => VerifiedDeployment | undefined;
  /** A scoped #30 HistoryPort from createScopedEthereumBridge. */
  readonly history: (context: OperationContext) => HistoryPort;
  readonly receiptKeys: (context: OperationContext) => ReceiptKeyPort;
  readonly reservations: (context: OperationContext) => LiveReservationPort;
  readonly payment: (context: OperationContext) => { readonly client: PaymentClient };
  readonly paymentRecovery: (context: OperationContext) => RecoveryPorts;
  readonly reward: RewardOperation;
}

/** Recheck public IDs with server and finalized chain evidence before exposing any retry or receipt. */
export function createBrowserOperationActions(deps: BrowserOperationActionDependencies): Actions {
  function check(scope: Scope, context: OperationContext): { view: ViewState; verified: VerifiedDeployment; pinned: string } {
    context.check();
    const view = deps.snapshot();
    const verified = deps.resolveVerified(scope.deploymentId);
    if (!sameScope(scope, context.scope) || !sameScope(scope, view.scope) || !verified
      || verified.context.chainId !== BigInt(verified.manifest.chainId)
      || !same(verified.context.pool, verified.manifest.pool.address)) throw new Error('SCOPE_CHANGED');
    return { view, verified, pinned: fingerprint(verified) };
  }
  function still(scope: Scope, context: OperationContext, pinned: string): void {
    if (check(scope, context).pinned !== pinned) throw new Error('SCOPE_CHANGED');
  }
  function known(scope: Scope, id: OperationId, previous: ViewState): { ref: OperationRef; card: Card } {
    if (!sameScope(scope, previous.scope)) throw new Error('SCOPE_CHANGED');
    const matches = previous.operations.filter(item => same(item.operationId, id) && sameScope(item.scope, scope));
    const card = previous.operationCards[id];
    if (matches.length !== 1 || !card) throw new Error('NOT_ALLOWED');
    return { ref: matches[0]!, card };
  }
  function project(scope: Scope, previous: ViewState, card: Card, ref: OperationRef,
    actions: readonly ViewState['operationActions'][string][number][] = ['recheck']): OperationResult {
    const phase: CardPhase = ref.chainOutcome === 'finalized-success'
      ? ref.receiptState === 'invalid' ? 'receipt-invalid'
        : ref.receiptState === 'pending' ? 'confirmed-receipt-pending' : 'complete'
      : ref.chainOutcome === 'finalized-failure' ? 'failed'
        : ref.chainOutcome === 'pending' ? 'pending' : 'unknown';
    const permitted = previous.isStale || previous.storageAvailability !== 'healthy' ? ['recheck' as const] : actions;
    return { scope, operation: ref, card, view: { ...previous,
      operations: [...previous.operations.filter(item => !same(item.operationId, ref.operationId)), ref],
      operationCards: { ...previous.operationCards, [ref.operationId]: card },
      operationActions: { ...previous.operationActions, [ref.operationId]: permitted },
      allowedActions: previous.allowedActions.filter(action => action !== `start:${card}`),
      reasons: { ...previous.reasons, [`start:${card}`]: ref.chainOutcome === 'finalized-success'
        ? 'INPUT_RESERVED' : 'RESULT_UNKNOWN' },
      cards: { ...previous.cards, [card]: { ...previous.cards[card], phase,
        reason: phase === 'unknown' ? 'RESULT_UNKNOWN' : phase === 'receipt-invalid' ? 'RECEIPT_INVALID' : undefined } },
    } };
  }
  async function saved(scope: Scope, id: OperationId, context: OperationContext, pinned: string): Promise<LiveSavedReservation> {
    const listed = await deps.reservations(context).list(scope);
    still(scope, context, pinned);
    if (listed.availability !== 'healthy') throw new Error('SERVICE_UNAVAILABLE');
    const matches = listed.records.filter(row => sameScope(row.record.scope, scope)
      && same(row.record.operationId, id));
    const active = matches.filter(row => row.reservationState === 'active');
    if (active.length === 1) return active[0]!;
    if (active.length > 1 || matches.length > 1) throw new Error('AMBIGUOUS_OPERATION');
    if (matches.length !== 1) throw new Error('OPERATION_NOT_FOUND');
    return matches[0]!;
  }

  async function finalized(scope: Scope, id: OperationId, context: OperationContext,
    verified: VerifiedDeployment, pinned: string, card: Card,
    row?: LiveSavedReservation): Promise<{ found: boolean;
      receipt?: ReceivedUtxo | ReceiptFailure }> {
    const history = deps.history(context);
    const point = await history.getFinalizedCheckpoint();
    still(scope, context, pinned);
    if (!point || point.mode !== verified.context.finalityMode
      || point.number < verified.context.deploymentBlock) return { found: false };
    const selectedPoint = point;
    const contextAtPoint = await history.getContext(point);
    const operations = await history.getOperations(verified.context.deploymentBlock, point);
    still(scope, context, pinned);
    if (!complete(contextAtPoint, point.hash) || !complete(operations, point.hash)
      || fingerprint(contextAtPoint.value) !== fingerprint(verified.context)) return { found: false };
    const matching = operations.value.filter(item => item.success && same(item.success.operationId, id));
    if (matching.length !== 1 || !matching[0]?.success
      || !same(coreOperationId(verified.context, matching[0].request), id)) return { found: false };
    const observed = matching[0];
    const success = observed.success!;
    const request = observed.request;
    if (card === 'withdraw' && (!row || row.record.kind !== 'withdraw'
      || request.kind !== 2 || !same(request.owner, scope.owner)
      || request.inputIds.length !== 1 || !same(request.inputIds[0]!, row.record.inputId)
      || request.outputs.length !== 0 || request.d !== 0n || request.w <= 0n
      || !same(request.destination, scope.owner))) return { found: false };
    if (card === 'deposit' && (request.kind !== 0 || !same(request.owner, scope.owner)
      || request.inputIds.length !== 0 || request.outputs.length !== 1
      || request.d <= 0n || request.w !== 0n
      || !same(request.outputs[0]!.owner, scope.owner))) return { found: false };
    const header = await history.getCanonicalHeader(success.blockNumber, point);
    const operation = await history.getOperationSuccess(id, point);
    still(scope, context, pinned);
    if (!complete(header, point.hash) || !same(header.value.hash, success.blockHash)
      || !complete(operation, point.hash) || !operation.value.executed) return { found: false };
    if (operation.value.operation && !same(coreOperationId(verified.context, operation.value.operation), id)) {
      return { found: false };
    }
    const owned = observed.request.outputs.map((output, index) => ({ output, index }))
      .filter(item => same(item.output.owner, scope.owner));
    async function canonical(): Promise<boolean> {
      const again = await history.getFinalizedCheckpoint();
      still(scope, context, pinned);
      return !!again && again.number === selectedPoint.number && same(again.hash, selectedPoint.hash)
        && again.mode === selectedPoint.mode;
    }
    if (owned.length === 0) return { found: await canonical() };
    if (owned.length !== 1) return { found: await canonical(), receipt: { status: 'unknown', reason: 'OUTPUT_INDEX' } };
    const selected = owned[0]!;
    const utxo = await history.getUtxo(outputId(id, selected.index), point);
    const consumingOperation = utxo.complete && utxo.value.consumedBy
      ? await history.getOperationSuccess(utxo.value.consumedBy, point) : undefined;
    still(scope, context, pinned);
    const receipt = await inspectReceipt(observed, selected.index, scope.owner, deps.receiptKeys(context),
      { context: verified.context, creationBlock: header, operation, utxo,
        ...(consumingOperation ? { consumingOperation } : {}) }, point);
    still(scope, context, pinned);
    return { found: await canonical(), receipt };
  }

  async function recoveryActions(row: LiveSavedReservation, context: OperationContext,
    scope: Scope, pinned: string): Promise<readonly ViewState['operationActions'][string][number][]> {
    try {
      const evidence = await deps.paymentRecovery(context).readEvidence(row);
      still(scope, context, pinned);
      const action = inspectOperation(row, evidence.evidence, evidence.currentInput).action;
      return action === 'resume-original' || action === 'retry-attempt' ? ['recheck', action] : ['recheck'];
    } catch (error) {
      still(scope, context, pinned);
      return ['recheck'];
    }
  }

  async function recheck(...[scope, id, context, previous]: ActionArgs): Promise<OperationResult> {
    const initial = check(scope, context);
    const { ref, card } = known(scope, id, previous);
    if (card === 'pay' || card === 'withdraw') {
      const row = await saved(scope, id, context, initial.pinned);
      if (row.record.kind !== card) throw new Error('SCOPE_CHANGED');
      if (card === 'pay') {
        const currentRef = row.record.kind === 'pay' ? { ...ref, paymentId: row.record.paymentId } : ref;
        const reconciled = await deps.payment(context).client.reconcile(row.record.recordId, currentRef);
        still(scope, context, initial.pinned);
        const actions = reconciled.operation.chainOutcome === 'finalized-success'
          ? reconciled.operation.receiptState === 'confirmed' ? ['recheck' as const]
            : ['recheck' as const, 'acknowledge-receipt' as const]
          : await recoveryActions(row, context, scope, initial.pinned);
        return project(scope, previous, card, reconciled.operation, actions);
      }
      const chain = await finalized(scope, id, context, initial.verified, initial.pinned, card, row);
      const next: OperationRef = chain.found ? { ...ref, chainOutcome: 'finalized-success', receiptState: 'none' }
        : { ...ref, chainOutcome: 'unknown', receiptState: 'none' };
      const actions = chain.found ? ['recheck' as const] : await recoveryActions(row, context, scope, initial.pinned);
      return project(scope, previous, card, next, actions);
    }
    if (card === 'reward') {
      const request = previous.rewardRequests.filter(item => item.operationId && same(item.operationId, id));
      if (request.length !== 1) throw new Error('AMBIGUOUS_OPERATION');
      const reward = await deps.reward.recheck(scope, request[0]!.requestId, context);
      still(scope, context, initial.pinned);
      const chain = await finalized(scope, id, context, initial.verified, initial.pinned, card);
      const next: OperationRef = chain.found ? { ...ref, chainOutcome: 'finalized-success',
        receiptState: chain.receipt?.status === 'available' || chain.receipt?.status === 'spent' ? 'confirmed'
          : chain.receipt?.status === 'inconsistent' ? 'invalid' : 'pending' }
        : { ...ref, chainOutcome: 'unknown', receiptState: 'pending' };
      return project(scope, reward.view, card, next,
        chain.found ? ['recheck', 'acknowledge-receipt'] : ['recheck']);
    }
    const chain = await finalized(scope, id, context, initial.verified, initial.pinned, card);
    const next: OperationRef = chain.found ? { ...ref, chainOutcome: 'finalized-success',
      receiptState: chain.receipt?.status === 'available' || chain.receipt?.status === 'spent' ? 'confirmed'
        : chain.receipt?.status === 'inconsistent' ? 'invalid' : 'pending' }
      : { ...ref, chainOutcome: 'unknown', receiptState: 'pending' };
    return project(scope, previous, card, next,
      chain.found && next.receiptState !== 'confirmed' ? ['recheck', 'acknowledge-receipt'] : ['recheck']);
  }

  async function submit(action: 'resumeOriginal' | 'retryAttempt', ...[scope, id, context, previous]: ActionArgs): Promise<OperationResult> {
    const initial = check(scope, context);
    const { ref, card } = known(scope, id, previous);
    if (card !== 'pay' && card !== 'withdraw') throw new Error('NOT_ALLOWED');
    const row = await saved(scope, id, context, initial.pinned);
    if (row.record.kind !== card) throw new Error('SCOPE_CHANGED');
    const outcome: SubmissionOutcome = await deps.payment(context).client[action](row.record.recordId);
    still(scope, context, initial.pinned);
    const after = await saved(scope, id, context, initial.pinned);
    const next: OperationRef = { ...ref, attemptIds: [...after.record.attemptIds],
      txHashes: outcome.kind === 'submitted' ? [...ref.txHashes, outcome.txHash] : ref.txHashes,
      chainOutcome: outcome.kind === 'submitted' ? 'pending' : 'unknown' };
    return project(scope, previous, card, next);
  }

  async function receive(...[scope, id, context, previous]: ActionArgs): Promise<OperationResult> {
    const initial = check(scope, context);
    const { ref, card } = known(scope, id, previous);
    if (card === 'pay') return recheck(scope, id, context, previous);
    if (card !== 'deposit' && card !== 'reward') throw new Error('NOT_ALLOWED');
    const chain = await finalized(scope, id, context, initial.verified, initial.pinned, card);
    if (!chain.found) return project(scope, previous, card,
      { ...ref, chainOutcome: 'unknown', receiptState: 'pending' });
    const receipt = chain.receipt;
    if (!receipt || (receipt.status !== 'available' && receipt.status !== 'spent')
      || !same(receipt.operationId, id) || !same(receipt.utxo.owner, scope.owner)) {
      return project(scope, previous, card, { ...ref, chainOutcome: 'finalized-success',
        receiptState: receipt?.status === 'inconsistent' ? 'invalid' : 'pending' }, ['recheck', 'acknowledge-receipt']);
    }
    let base = previous;
    if (card === 'reward') {
      const request = previous.rewardRequests.filter(item => item.operationId && same(item.operationId, id));
      if (request.length !== 1) throw new Error('AMBIGUOUS_OPERATION');
      const marked = await deps.reward.receive(scope, request[0]!.requestId, receipt, context);
      still(scope, context, initial.pinned);
      base = marked.view;
    }
    return project(scope, base, card,
      { ...ref, chainOutcome: 'finalized-success', receiptState: 'confirmed' });
  }

  return { recheck,
    resumeOriginal: (...args) => submit('resumeOriginal', ...args),
    retryAttempt: (...args) => submit('retryAttempt', ...args),
    receive };
}
