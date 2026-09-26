import type {
  AttemptId, OperationId, OperationRef, Scope, TxHash,
} from '@confidential-utxo/uniswap';
import type { ManualClock, MemoryStore } from '@confidential-utxo/uniswap/testing';
import { actionKey } from '../contracts/controller.js';
import type { DispatchResult, UiAction, UiController } from '../contracts/controller.js';
import type { ApprovalPurpose, Card, CardState, ReasonCode, ViewState } from '../contracts/state.js';
import { initialScenario } from './scenarios.js';

export type ScenarioEvent = (
  | { readonly type: 'preparing'; readonly card: Card }
  | { readonly type: 'quote'; readonly startedAt: number; readonly quoteOut: bigint; readonly latestBlockTimestamp: number }
  | { readonly type: 'reservation-ack'; readonly card: 'pay' | 'withdraw' }
  | { readonly type: 'awaiting-approval'; readonly card: Card; readonly purpose: ApprovalPurpose }
  | { readonly type: 'submitted'; readonly card: Card; readonly operationId: OperationId; readonly attemptId?: string; readonly txHash?: TxHash }
  | { readonly type: 'unknown'; readonly card: Card; readonly operationId: OperationId }
  | { readonly type: 'finalized-success'; readonly card: Card; readonly operationId: OperationId; readonly attemptId?: string; readonly amountWei?: bigint }
  | { readonly type: 'receipt-invalid'; readonly card: Card; readonly operationId: OperationId }
  | { readonly type: 'receipt-confirmed'; readonly card: Card; readonly operationId: OperationId; readonly outputId: string; readonly amountWei: bigint }
  | { readonly type: 'reorg'; readonly card: Card; readonly operationId: OperationId }
  | { readonly type: 'attempt-failed'; readonly card: Card; readonly operationId: OperationId; readonly attemptId?: string; readonly otherAttemptPending: boolean; readonly inputUnspent: boolean; readonly deadlineValid: boolean }
  | { readonly type: 'original-unsent'; readonly card: Card; readonly operationId: OperationId; readonly inputUnspent: boolean; readonly deadlineValid: boolean }
  | { readonly type: 'terms-changed'; readonly card: 'pay'; readonly oldAuthorizationActive: boolean }
) & { readonly scope?: Scope };

export interface ScenarioJournalEntry {
  readonly kind: 'start' | 'send' | 'recheck' | 'resync' | 'scope-switch';
  readonly scope: Scope;
  readonly operationId?: OperationId;
}

export interface ScenarioControl {
  inject(event: ScenarioEvent): void;
  pending(): readonly Card[];
  reset(scenario: string): void;
  journal(): readonly ScenarioJournalEntry[];
}

export interface MockUiController extends UiController {
  readonly control: ScenarioControl;
}

interface Runtime {
  state: ViewState;
  quoteStartedAt?: number;
  reservationAck: Set<Card>;
  retryEligible: Set<OperationId>;
  resumeEligible: Set<OperationId>;
  oldAuthorizationActive: boolean;
  countedOutputs: Map<string, { operationId: OperationId; amountWei: bigint }>;
}

function scopeKey(scope: Scope): string {
  return `${scope.deploymentId}\u0000${scope.owner.toLowerCase()}`;
}

function makeRuntime(scope: Scope, scenario: string): Runtime {
  return {
    state: initialScenario(scope, scenario),
    reservationAck: new Set(),
    retryEligible: new Set(),
    resumeEligible: new Set(),
    oldAuthorizationActive: false,
    countedOutputs: new Map(),
  };
}

function setCard(state: ViewState, card: Card, update: Partial<CardState>): ViewState {
  return {
    ...state,
    cards: { ...state.cards, [card]: { ...state.cards[card], ...update } },
  };
}

function setOperation(state: ViewState, operationId: OperationId, update: Partial<OperationRef>): ViewState {
  const current = state.operations.find((operation) => operation.operationId === operationId);
  const next: OperationRef = {
    scope: state.scope,
    operationId,
    attemptIds: [],
    txHashes: [],
    chainOutcome: 'not-submitted',
    receiptState: 'none',
    ...current,
    ...update,
  };
  return {
    ...state,
    operations: current === undefined
      ? [...state.operations, next]
      : state.operations.map((operation) => operation.operationId === operationId ? next : operation),
  };
}

function appendAttempt(state: ViewState, operationId: OperationId, attemptId?: string): ViewState {
  if (attemptId === undefined) return state;
  const current = state.operations.find((operation) => operation.operationId === operationId);
  const existing = current?.attemptIds ?? [];
  if (existing.includes(attemptId as AttemptId)) return state;
  return setOperation(state, operationId, { attemptIds: [...existing, attemptId as AttemptId] });
}

function quoteValid(startedAt: number | undefined, now: number): boolean {
  if (startedAt === undefined || !Number.isFinite(now) || !Number.isFinite(startedAt)) return false;
  const age = now - startedAt;
  return age >= 0 && age <= 30000;
}

function derive(runtime: Runtime, now: number): ViewState {
  const allowed = new Set<string>(['switch-scope', 'resync']);
  const reasons: Record<string, ReasonCode> = {};
  const state = runtime.state;
  for (const card of ['reward', 'pay', 'deposit', 'withdraw'] as const) {
    const phase = state.cards[card].phase;
    if (phase === 'ready' || phase === 'needs-preparation' || phase === 'invalid-input' || phase === 'confirm-terms') {
      allowed.add(`edit:${card}`);
    }
    if (phase === 'ready') {
      if (card === 'pay' && !quoteValid(runtime.quoteStartedAt, now)) {
        reasons['start:pay'] = 'QUOTE_STALE';
      } else if (card === 'reward' && state.cards.reward.phase === 'unknown') {
        reasons['start:reward'] = 'RESULT_UNKNOWN';
      } else {
        allowed.add(`start:${card}`);
      }
    }
    if (phase === 'confirm-terms') {
      if (card === 'pay' && !runtime.oldAuthorizationActive) allowed.add('confirm-terms');
      else reasons['confirm-terms'] = 'AUTHORIZATION_ACTIVE';
    }
    if (phase === 'unknown' || phase === 'pending' || phase === 'failed' || phase === 'receipt-invalid') {
      allowed.add('recheck');
      reasons[`start:${card}`] = phase === 'unknown' ? 'RESULT_UNKNOWN' : 'NOT_ALLOWED';
    }
  }
  for (const operationId of runtime.retryEligible) {
    if (state.operations.some((operation) => operation.operationId === operationId)) allowed.add('retry-attempt');
  }
  for (const operationId of runtime.resumeEligible) {
    if (state.operations.some((operation) => operation.operationId === operationId)) allowed.add('resume-original');
  }
  if (state.cards.pay.phase === 'confirmed-receipt-pending'
    || state.cards.pay.phase === 'receipt-invalid'
    || state.cards.reward.phase === 'confirmed-receipt-pending') {
    allowed.add('acknowledge-receipt');
  }
  return { ...state, allowedActions: [...allowed], reasons };
}

export function createMockUiController({ scope, store, clock, scenario }: {
  readonly scope: Scope;
  readonly store: MemoryStore;
  readonly clock: ManualClock;
  readonly scenario: string;
}): MockUiController {
  const scopes = new Map<string, Runtime>();
  const subscribers = new Set<(state: ViewState) => void>();
  const entries: ScenarioJournalEntry[] = [];
  let activeScope = scope;
  let disposed = false;
  scopes.set(scopeKey(scope), makeRuntime(scope, scenario));

  function active(): Runtime {
    const runtime = scopes.get(scopeKey(activeScope));
    if (runtime === undefined) throw new Error('missing active scope');
    return runtime;
  }

  function notify(): void {
    if (disposed) return;
    const state = snapshot();
    for (const subscriber of subscribers) subscriber(state);
  }

  function snapshot(): ViewState {
    return structuredClone(derive(active(), clock.now()));
  }

  function inject(event: ScenarioEvent): void {
    if (disposed) return;
    const eventScope = event.scope ?? activeScope;
    const key = scopeKey(eventScope);
    let runtime = scopes.get(key);
    if (runtime === undefined) {
      runtime = makeRuntime(eventScope, 'ready');
      scopes.set(key, runtime);
    }
    let state = runtime.state;
    if (event.type === 'quote') {
      runtime.quoteStartedAt = event.startedAt;
      state = setCard(state, 'pay', {
        quote: {
          startedAt: event.startedAt,
          quoteOut: event.quoteOut,
          minAmountOut: (event.quoteOut * 99n / 100n) > 0n ? event.quoteOut * 99n / 100n : 1n,
          deadline: event.latestBlockTimestamp + 600,
        },
      });
    } else if (event.type === 'reservation-ack') {
      runtime.reservationAck.add(event.card);
    } else if (event.type === 'awaiting-approval') {
      if ((event.card !== 'pay' && event.card !== 'withdraw') || runtime.reservationAck.has(event.card)) {
        state = setCard(state, event.card, { phase: 'awaiting-approval', approvalPurpose: event.purpose });
      }
    } else if (event.type === 'preparing') {
      state = setCard(state, event.card, { phase: 'preparing' });
    } else if (event.type === 'submitted') {
      state = setCard(state, event.card, { phase: 'pending' });
      const current = state.operations.find((operation) => operation.operationId === event.operationId);
      const hashes = event.txHash === undefined ? current?.txHashes ?? [] : [...(current?.txHashes ?? []), event.txHash];
      state = setOperation(state, event.operationId, { chainOutcome: 'pending', txHashes: hashes });
      state = appendAttempt(state, event.operationId, event.attemptId);
    } else if (event.type === 'unknown') {
      state = setCard(state, event.card, { phase: 'unknown', reason: 'RESULT_UNKNOWN' });
      state = setOperation(state, event.operationId, { chainOutcome: 'unknown' });
    } else if (event.type === 'finalized-success') {
      state = setCard(state, event.card, { phase: 'confirmed-receipt-pending' });
      state = setOperation(state, event.operationId, { chainOutcome: 'finalized-success', receiptState: 'pending' });
      state = appendAttempt(state, event.operationId, event.attemptId);
    } else if (event.type === 'receipt-invalid') {
      state = setCard(state, event.card, { phase: 'receipt-invalid', reason: 'RECEIPT_INVALID' });
      state = setOperation(state, event.operationId, { receiptState: 'invalid' });
    } else if (event.type === 'receipt-confirmed') {
      const operation = state.operations.find((item) => item.operationId === event.operationId);
      if (operation?.chainOutcome === 'finalized-success') {
        if (!runtime.countedOutputs.has(event.outputId)) {
          runtime.countedOutputs.set(event.outputId, { operationId: event.operationId, amountWei: event.amountWei });
          state = { ...state, availablePrivateWei: state.availablePrivateWei + event.amountWei };
        }
        state = setCard(state, event.card, { phase: 'complete' });
        state = setOperation(state, event.operationId, { receiptState: 'confirmed' });
      }
    } else if (event.type === 'reorg') {
      let removed = 0n;
      for (const [outputId, item] of runtime.countedOutputs) {
        if (item.operationId === event.operationId) {
          removed += item.amountWei;
          runtime.countedOutputs.delete(outputId);
        }
      }
      state = { ...state, availablePrivateWei: state.availablePrivateWei - removed, isStale: true };
      state = setCard(state, event.card, { phase: 'unknown', reason: 'RESULT_UNKNOWN' });
      state = setOperation(state, event.operationId, { chainOutcome: 'unknown', receiptState: 'none' });
    } else if (event.type === 'attempt-failed') {
      state = setCard(state, event.card, { phase: 'failed' });
      state = setOperation(state, event.operationId, { chainOutcome: 'finalized-failure' });
      state = appendAttempt(state, event.operationId, event.attemptId);
      if (!event.otherAttemptPending && event.inputUnspent && event.deadlineValid) {
        runtime.retryEligible.add(event.operationId);
      } else runtime.retryEligible.delete(event.operationId);
    } else if (event.type === 'original-unsent') {
      state = setOperation(state, event.operationId, { chainOutcome: 'not-submitted' });
      if (event.inputUnspent && event.deadlineValid) runtime.resumeEligible.add(event.operationId);
      else runtime.resumeEligible.delete(event.operationId);
    } else if (event.type === 'terms-changed') {
      runtime.oldAuthorizationActive = event.oldAuthorizationActive;
      state = setCard(state, event.card, { phase: 'confirm-terms', reason: event.oldAuthorizationActive ? 'AUTHORIZATION_ACTIVE' : undefined });
    }
    runtime.state = state;
    if (key === scopeKey(activeScope)) notify();
  }

  return {
    snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async dispatch(action: UiAction): Promise<DispatchResult> {
      if (disposed) return { kind: 'blocked', reason: 'NOT_ALLOWED' };
      if (action.type === 'switch-scope') {
        activeScope = action.scope;
        if (!scopes.has(scopeKey(activeScope))) scopes.set(scopeKey(activeScope), makeRuntime(activeScope, 'ready'));
        entries.push({ kind: 'scope-switch', scope: activeScope });
        notify();
        return { kind: 'accepted' };
      }
      const runtime = active();
      const view = derive(runtime, clock.now());
      const key = actionKey(action);
      if (!view.allowedActions.includes(key)) {
        return { kind: 'blocked', reason: view.reasons[key] ?? 'NOT_ALLOWED' };
      }
      if (action.type === 'start') {
        runtime.state = setCard(runtime.state, action.card, { phase: 'preparing' });
        entries.push({ kind: 'start', scope: activeScope });
      } else if (action.type === 'edit') {
        const card = runtime.state.cards[action.card];
        runtime.state = setCard(runtime.state, action.card, { input: { ...card.input, [action.field]: action.value } });
      } else if (action.type === 'confirm-terms') {
        runtime.state = setCard(runtime.state, 'pay', { phase: 'preparing', reason: undefined });
      } else if (action.type === 'retry-attempt' || action.type === 'resume-original') {
        const eligible = action.type === 'retry-attempt' ? runtime.retryEligible : runtime.resumeEligible;
        if (!eligible.has(action.operationId)
          || !runtime.state.operations.some((operation) => operation.operationId === action.operationId)) {
          return { kind: 'blocked', reason: 'NOT_ALLOWED' };
        }
        runtime.retryEligible.delete(action.operationId);
        runtime.resumeEligible.delete(action.operationId);
        entries.push({ kind: 'send', scope: activeScope, operationId: action.operationId });
      } else if (action.type === 'recheck') {
        try {
          store.operations.list(activeScope);
          runtime.state = { ...runtime.state, checkedAt: clock.now() };
        } catch {
          runtime.state = { ...runtime.state, isStale: true };
        }
        entries.push({ kind: 'recheck', scope: activeScope, operationId: action.operationId });
      } else if (action.type === 'resync') {
        runtime.state = { ...runtime.state, checkedAt: clock.now() };
        entries.push({ kind: 'resync', scope: activeScope });
      }
      notify();
      return { kind: 'accepted' };
    },
    dispose() {
      subscribers.clear();
      disposed = true;
    },
    control: {
      inject,
      pending: () => (Object.entries(active().state.cards) as [Card, CardState][])
        .filter(([, card]) => ['preparing', 'awaiting-approval', 'submitting', 'pending', 'unknown'].includes(card.phase))
        .map(([card]) => card),
      reset(nextScenario) {
        scopes.clear();
        scopes.set(scopeKey(scope), makeRuntime(scope, nextScenario));
        activeScope = scope;
        entries.length = 0;
        notify();
      },
      journal: () => structuredClone(entries),
    },
  };
}
