import { isQuoteFresh, PaymentProcessError, type OperationId, type OperationRef,
  type PaymentClient, type PreparedFullWithdraw, type PreparedPay, type RequestId,
  type Scope } from '@confidential-utxo/uniswap';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Context, HistoryPort, ReceiptKeyPort, SyncResult as CoreSyncResult } from '@confidential-utxo/core';
import type { Card, UiAction, ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import { projectConnectionChange, projectDraft, projectScopeChange, projectUnconfirmedSync,
  type OperationContext, type OperationPort, type OperationResult, type PreparedOperation,
  type PreparationResult, type TransitionAction } from './operations.js';
import type { RewardOperation } from './reward-operation.js';
import type { RecoveryResult } from './recovery.js';
import { syncFinalizedForView } from './sync-projection.js';

type PaymentPrepared = PreparedPay | PreparedFullWithdraw;
interface PaymentBinding {
  /** This is #55's scoped client. Each action must use its captured context. */
  readonly client: PaymentClient;
  /** Rebuild a fresh decision on the same Worker draft, before any authorization. */
  refreshPay(prepared: PreparedPay): Promise<PreparedPay>;
  terms(prepared: PreparedPay): { readonly minAmountOut: bigint; readonly deadline: bigint };
  now(): number;
}
interface PreparedHandle {
  readonly scope: Scope;
  readonly epoch: number;
  readonly card: 'pay' | 'withdraw';
  readonly prepared: PaymentPrepared;
  readonly binding: PaymentBinding;
  readonly input: string;
  readonly deployment: string;
}

export interface OperationPortDependencies {
  snapshot(): ViewState;
  /** The resolver must identify its result; a core Context alone is not a deployment identity. */
  resolveVerified(id: Scope['deploymentId']): { readonly deploymentId: Scope['deploymentId']; readonly verified: VerifiedDeployment } | undefined;
  payment(context: OperationContext): PaymentBinding;
  /** Existing bounded adapters are injected without reimplementing their protocol rules. */
  reward: RewardOperation;
  deposit: Pick<OperationPort, 'prepareDeposit' | 'completePreparation' | 'authorize'>;
  coreSync(scope: Scope, context: OperationContext, verified: VerifiedDeployment): {
    readonly deploymentId: Scope['deploymentId']; readonly coreContext: Context;
    readonly history: HistoryPort; readonly keys: ReceiptKeyPort; readonly previousCore?: CoreSyncResult;
  };
  recheck(scope: Scope, operationId: OperationId, context: OperationContext, previous: ViewState): Promise<OperationResult>;
  resumeOriginal(scope: Scope, operationId: OperationId, context: OperationContext, previous: ViewState): Promise<OperationResult>;
  retryAttempt(scope: Scope, operationId: OperationId, context: OperationContext, previous: ViewState): Promise<OperationResult>;
  receive(scope: Scope, operationId: OperationId, context: OperationContext, previous: ViewState): Promise<OperationResult>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
const identity = (input: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
const result = (scope: Scope, view: ViewState, operation?: OperationRef, card?: Card): OperationResult =>
  ({ scope, view, ...(operation && card ? { operation, card } : {}) });
const paymentQuote = (prepared: PreparedPay, binding: PaymentBinding) => {
  const terms = binding.terms(prepared);
  return { startedAt: prepared.quote.startedAtMs, quoteOut: prepared.quote.quoteOut,
    minAmountOut: terms.minAmountOut, deadline: terms.deadline };
};

/** Compose the published payment client with the card boundary. Secret prepared values stay in a WeakMap. */
export function createOperationPort(deps: OperationPortDependencies): OperationPort {
  const handles = new WeakMap<object, PreparedHandle>();
  let pending: { readonly token: object; readonly scope: Scope; readonly epoch: number; readonly input: string } | undefined;
  let lastAttempt: { readonly scope: Scope; readonly card: Card; readonly reference: OperationRef } | undefined;
  function resolved(scope: Scope): VerifiedDeployment {
    const located = deps.resolveVerified(scope.deploymentId);
    if (!located || located.deploymentId !== scope.deploymentId
      || located.verified.context.chainId !== BigInt(located.verified.manifest.chainId)
      || !same(located.verified.context.pool, located.verified.manifest.pool.address)) throw new Error('SCOPE_CHANGED');
    return located.verified;
  }
  function check(scope: Scope, context: OperationContext): ViewState {
    context.check();
    const snapshot = deps.snapshot();
    if (!sameScope(scope, context.scope) || !sameScope(scope, snapshot.scope)) throw new Error('SCOPE_CHANGED');
    resolved(scope);
    return snapshot;
  }
  function wrap(scope: Scope, context: OperationContext, card: PreparedHandle['card'],
    prepared: PaymentPrepared, binding: PaymentBinding, input: string): PreparedOperation {
    check(scope, context);
    if (!sameScope(scope, prepared.record.scope) || prepared.record.kind !== card
      || prepared.record.operationId.length === 0) throw new Error('SCOPE_CHANGED');
    const token = Object.freeze({});
    handles.set(token, { scope: { ...scope }, epoch: context.epoch, card, prepared, binding, input,
      deployment: fingerprint(resolved(scope)) });
    return { scope: { ...scope }, card, operationId: prepared.record.operationId, handle: token };
  }
  function unwrap(value: PreparedOperation, context: OperationContext): PreparedHandle {
    check(value.scope, context);
    const handle = typeof value.handle === 'object' && value.handle !== null ? handles.get(value.handle) : undefined;
    if (!handle || !sameScope(handle.scope, value.scope) || handle.epoch !== context.epoch
      || handle.card !== value.card || !same(handle.prepared.record.operationId, value.operationId)
      || identity(deps.snapshot().cards[handle.card].input) !== handle.input
      || handle.deployment !== fingerprint(resolved(value.scope))) throw new Error('SCOPE_CHANGED');
    return handle;
  }
  function showTerms(snapshot: ViewState, scope: Scope, proposed: PreparedOperation,
    binding: PaymentBinding, context: OperationContext): OperationResult {
    const handle = unwrap(proposed, context);
    const fresh = handle.prepared as PreparedPay;
    const card = { ...snapshot.cards.pay, phase: 'confirm-terms' as const, reason: 'TERMS_CHANGED' as const,
      proposedQuote: paymentQuote(fresh, binding), approvalPurpose: undefined };
    return result(scope, { ...snapshot, cards: { ...snapshot.cards, pay: card },
      allowedActions: [...new Set([...snapshot.allowedActions.filter(item => item !== 'start:pay'), 'confirm-terms'])],
      reasons: { ...snapshot.reasons, 'start:pay': 'TERMS_CHANGED' } });
  }
  async function refresh(handle: PreparedHandle, context: OperationContext): Promise<PreparedOperation> {
    const next = await handle.binding.refreshPay(handle.prepared as PreparedPay);
    check(handle.scope, context);
    if (!same(next.record.operationId, handle.prepared.record.operationId)
      || !same(next.record.inputId, handle.prepared.record.inputId)
      || !same(next.record.recordId, handle.prepared.record.recordId)) throw new Error('SCOPE_CHANGED');
    // A new scoped #55 client accepts the refreshed decision as its initial private handle.
    return wrap(handle.scope, context, 'pay', next, deps.payment(context), handle.input);
  }
  function operationView(scope: Scope, card: Card, reference: OperationRef): OperationResult {
    const snapshot = deps.snapshot();
    if (!sameScope(scope, reference.scope)) throw new Error('SCOPE_CHANGED');
    const view: ViewState = { ...snapshot, operations: [...snapshot.operations.filter(item => !same(item.operationId, reference.operationId)), reference],
      operationCards: { ...snapshot.operationCards, [reference.operationId]: card },
      operationActions: { ...snapshot.operationActions, [reference.operationId]: ['recheck'] },
      cards: { ...snapshot.cards, [card]: { ...snapshot.cards[card], phase: reference.chainOutcome === 'pending' ? 'pending' : 'unknown',
        reason: reference.chainOutcome === 'pending' ? undefined : 'RESULT_UNKNOWN' } },
      allowedActions: snapshot.allowedActions.filter(item => item !== `start:${card}`),
      reasons: { ...snapshot.reasons, [`start:${card}`]: reference.chainOutcome === 'pending' ? 'INPUT_RESERVED' : 'RESULT_UNKNOWN' },
      selectedInput: { ...snapshot.selectedInput, [card]: undefined },
    };
    // #55 has reserved the input. A pending hash does not establish a new
    // spendable set, so require a fresh #30 sync before another spend.
    return result(scope, projectUnconfirmedSync(view), reference, card);
  }
  const port: OperationPort = {
    connectionChanged(previous, connection) { pending = undefined; lastAttempt = undefined; return projectConnectionChange(previous, connection); },
    switchScope(previous, scope) { pending = undefined; lastAttempt = undefined; return projectScopeChange(previous, scope); },
    async transition(scope, action: TransitionAction, previous, context) {
      check(scope, context);
      if (action.type === 'edit' || action.type === 'new-operation') {
        if (action.card === 'pay') pending = undefined;
        return result(scope, projectDraft(previous, action));
      }
      if (action.type === 'confirm-terms' && pending) {
        const candidate = pending;
        pending = undefined;
        if (!sameScope(candidate.scope, scope) || candidate.epoch !== context.epoch
          || identity(previous.cards.pay.input) !== candidate.input) throw new Error('SCOPE_CHANGED');
        return port.authorize({ scope, card: 'pay', operationId: handles.get(candidate.token)!.prepared.record.operationId,
          handle: candidate.token }, context);
      }
      throw new Error('NOT_ALLOWED');
    },
    async preparePay(scope, input, context) {
      check(scope, context);
      pending = undefined;
      const binding = deps.payment(context);
      const prepared = await binding.client.preparePay(input);
      return wrap(scope, context, 'pay', prepared, binding, identity(input));
    },
    prepareDeposit: (scope, input, context) => deps.deposit.prepareDeposit(scope, input, context),
    async prepareWithdraw(scope, input, context) {
      check(scope, context);
      const binding = deps.payment(context);
      const prepared = await binding.client.prepareFullWithdraw(input);
      return wrap(scope, context, 'withdraw', prepared, binding, identity(input));
    },
    async completePreparation(prepared, proof, context) {
      if (prepared.card === 'deposit') return deps.deposit.completePreparation(prepared, proof, context);
      const handle = unwrap(prepared, context);
      if (proof !== undefined) throw new Error('INVALID_PAYMENT_PROOF');
      if (handle.card === 'pay' && !isQuoteFresh((handle.prepared as PreparedPay).quote, handle.binding.now())) {
        const refreshed = await refresh(handle, context);
        const fresh = unwrap(refreshed, context);
        if (!same(fresh.prepared.record.contentHash, handle.prepared.record.contentHash)) {
          pending = { token: refreshed.handle as object, scope: { ...handle.scope }, epoch: context.epoch, input: handle.input };
          return { kind: 'decision', result: showTerms(deps.snapshot(), handle.scope, refreshed, fresh.binding, context) };
        }
        return { kind: 'prepared', prepared: refreshed };
      }
      return { kind: 'prepared', prepared };
    },
    async authorize(prepared, context) {
      if (prepared.card === 'deposit') return deps.deposit.authorize(prepared, context);
      const handle = unwrap(prepared, context);
      const confirmed = handle.prepared.record.contentHash;
      lastAttempt = { scope: handle.scope, card: handle.card, reference: {
        scope: handle.scope, operationId: handle.prepared.record.operationId,
        ...(handle.prepared.record.kind === 'pay' ? { paymentId: handle.prepared.record.paymentId } : {}),
        attemptIds: [], txHashes: [], chainOutcome: 'unknown', receiptState: 'none',
      } };
      let reference: OperationRef;
      try {
        reference = handle.card === 'pay'
          ? await handle.binding.client.authorizePay(handle.prepared as PreparedPay, confirmed)
          : await handle.binding.client.authorizeFullWithdraw(handle.prepared as PreparedFullWithdraw, confirmed);
      } catch (error) {
        if (handle.card === 'pay' && error instanceof PaymentProcessError && error.code === 'TERMS_CHANGED') {
          const refreshed = await refresh(handle, context);
          const fresh = unwrap(refreshed, context);
          lastAttempt = undefined;
          pending = { token: refreshed.handle as object, scope: { ...handle.scope }, epoch: context.epoch, input: handle.input };
          return showTerms(deps.snapshot(), handle.scope, refreshed, fresh.binding, context);
        }
        throw error;
      }
      check(handle.scope, context);
      lastAttempt = undefined;
      return operationView(handle.scope, handle.card, reference);
    },
    async syncFinalized(scope, context, recovered) {
      const previous = check(scope, context);
      const verified = resolved(scope);
      const expected = fingerprint(verified);
      const source = deps.coreSync(scope, context, verified);
      if (source.deploymentId !== scope.deploymentId || fingerprint(source.coreContext) !== fingerprint(verified.context)) {
        throw new Error('SCOPE_CHANGED');
      }
      const projected = await syncFinalizedForView({ previous, action: context, coreContext: source.coreContext,
        history: source.history, keys: source.keys, previousCore: source.previousCore,
        storageAvailability: previous.storageAvailability });
      check(scope, context);
      if (fingerprint(resolved(scope)) !== expected) throw new Error('SCOPE_CHANGED');
      // Recovery may inform the caller's ports, but it cannot replace #30's chain evidence.
      void recovered;
      return result(scope, projected.view);
    },
    startReward: (scope, input, context) => deps.reward.start(scope, input, context),
    recheckReward: (scope, requestId: RequestId, context) => deps.reward.recheck(scope, requestId, context),
    recheck: (scope, operationId, context) => deps.recheck(scope, operationId, context, check(scope, context)),
    resumeOriginal: (scope, operationId, context) => deps.resumeOriginal(scope, operationId, context, check(scope, context)),
    retryAttempt: (scope, operationId, context) => deps.retryAttempt(scope, operationId, context, check(scope, context)),
    receive: (scope, operationId, context) => deps.receive(scope, operationId, context, check(scope, context)),
    failure(scope, action: UiAction, previous, error) {
      if (!sameScope(scope, previous.scope)) throw new Error('SCOPE_CHANGED');
      const message = error instanceof Error ? error.message : '';
      const reason = message === 'SCOPE_CHANGED' ? 'SCOPE_CHANGED'
        : message === 'TERMS_CHANGED' ? 'TERMS_CHANGED'
          : message === 'QUOTE_STALE' ? 'QUOTE_STALE' : 'RESULT_UNKNOWN';
      const card = action.type === 'start' ? action.card : undefined;
      let view = projectUnconfirmedSync(previous);
      if (lastAttempt && sameScope(lastAttempt.scope, scope)) {
        const { card: attemptedCard, reference } = lastAttempt;
        view = { ...view,
          operations: [...view.operations.filter(item => !same(item.operationId, reference.operationId)), reference],
          operationCards: { ...view.operationCards, [reference.operationId]: attemptedCard },
          operationActions: { ...view.operationActions, [reference.operationId]: ['recheck'] },
        };
      }
      lastAttempt = undefined;
      return result(scope, card ? { ...view, cards: { ...view.cards, [card]: { ...view.cards[card], phase: 'unknown', reason } },
        reasons: { ...view.reasons, [`start:${card}`]: reason } } : view);
    },
  };
  return port;
}
