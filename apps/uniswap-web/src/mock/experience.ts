import type { Bytes32, OperationId, RequestId, Scope } from '@confidential-utxo/uniswap';
import { createManualClock, createMemoryStore } from '@confidential-utxo/uniswap/testing';
import type { ManualClock, MemoryStore } from '@confidential-utxo/uniswap/testing';
import type { DispatchResult, UiAction, UiController } from '../contracts/controller.js';
import type { Card, ViewState } from '../contracts/state.js';
import { decodeSession, encodeSession } from './browser-session.js';
import type { RecordedStep } from './browser-session.js';
import { createMockUiController, parseEthWei } from './controller.js';
import type { MockUiController } from './controller.js';

interface Flow {
  readonly card: Card;
  readonly operationId: OperationId;
  readonly outputId: Bytes32;
  readonly requestId?: RequestId;
  readonly amountWei: bigint;
  readonly changeWei: bigint;
  stage: number;
}

export interface MockExperience extends UiController {
  advance(): void;
  save(): string;
  restore(serialized: string): Promise<void>;
  reset(): void;
  readonly mock: MockUiController;
  readonly clock: ManualClock;
  readonly store: MemoryStore;
}

function identifier(counter: number, salt: number): `0x${string}` {
  return `0x${(BigInt(counter) * 16n + BigInt(salt)).toString(16).padStart(64, '0')}`;
}

export function createMockExperience({ scope }: { readonly scope: Scope }): MockExperience {
  const clock = createManualClock(0);
  const store = createMemoryStore();
  let mock = createMockUiController({ scope, clock, store, scenario: 'disconnected' });
  let unsubscribe = () => {};
  let counter = 0;
  let flow: Flow | undefined;
  let recorded: RecordedStep[] = [];
  const listeners = new Set<(view: ViewState) => void>();

  function snapshot(): ViewState {
    const view = mock.snapshot();
    if (flow === undefined) return view;
    const starts = ['reward', 'pay', 'deposit', 'withdraw'].map((card) => `start:${card}`);
    return { ...view,
      allowedActions: view.allowedActions.filter((action) => !starts.includes(action)),
      reasons: { ...view.reasons, ...Object.fromEntries(starts.map((action) => [action, 'NOT_ALLOWED' as const])) },
    };
  }

  function attach(): void {
    unsubscribe();
    unsubscribe = mock.subscribe((view) => {
      void view;
      for (const listener of listeners) listener(snapshot());
    });
  }
  attach();

  async function dispatch(action: UiAction, record = true): Promise<DispatchResult> {
    if (flow !== undefined && action.type === 'start') return { kind: 'blocked', reason: 'NOT_ALLOWED' };
    const result = await mock.dispatch(action);
    if (result.kind !== 'accepted') return result;
    if (record) recorded.push({ kind: 'action', action });
    if (action.type === 'edit' && action.card === 'pay') {
      const view = mock.snapshot();
      const amount = parseEthWei(view.cards.pay.input.amount);
      if (view.cards.pay.phase === 'ready' && amount !== undefined) {
        mock.control.inject({ type: 'quote', startedAt: clock.now(), quoteOut: amount * 100n,
          latestBlockTimestamp: 1_790_460_000 });
      }
    }
    if (action.type === 'start') {
      counter += 1;
      const view = mock.snapshot();
      const operationId = identifier(counter, 1) as OperationId;
      const amountWei = action.card === 'withdraw'
        ? view.selectedInput.withdraw?.amountWei ?? 0n
        : parseEthWei(view.cards[action.card].input.amount) ?? 0n;
      const requestId = action.card === 'reward' ? identifier(counter, 2) as RequestId : undefined;
      flow = { card: action.card, operationId, outputId: identifier(counter, 3) as Bytes32,
        amountWei, changeWei: action.card === 'pay' ? view.selectedInput.pay?.changeWei ?? 0n : 0n,
        requestId, stage: 0 };
      if (requestId !== undefined) {
        store.rewards.create({ scope: view.scope, requestId, amountWei, recipientInfo: {
          owner: view.scope.owner, publicKey: identifier(counter, 4) as Bytes32, signature: '0x00',
        } });
        mock.control.inject({ type: 'reward-request', requestId, status: 'accepted', operationId });
      }
      for (const listener of listeners) listener(snapshot());
    }
    return result;
  }

  function advance(record = true): void {
    if (flow === undefined) return;
    const current = flow;
    if (record) recorded.push({ kind: 'advance' });
    if (current.stage === 0) {
      if (current.card === 'pay' || current.card === 'withdraw') mock.control.inject({ type: 'reservation-ack', card: current.card });
      mock.control.inject({ type: 'awaiting-approval', card: current.card,
        purpose: current.card === 'pay' ? 'pool-authorization' : 'transaction' });
    } else if (current.stage === 1) {
      mock.control.inject({ type: 'submitted', card: current.card, operationId: current.operationId });
      if (current.requestId !== undefined) {
        mock.control.inject({ type: 'reward-request', requestId: current.requestId, status: 'pending', operationId: current.operationId });
      }
    } else if (current.stage === 2) {
      mock.control.inject({ type: 'finalized-success', card: current.card, operationId: current.operationId });
      if (current.requestId !== undefined) {
        store.control.setRewardFinalized(scope, current.requestId, current.outputId, identifier(counter, 5) as Bytes32);
        mock.control.inject({ type: 'reward-request', requestId: current.requestId, status: 'finalized', operationId: current.operationId });
      }
    } else {
      if (current.card !== 'withdraw') {
        const received = current.card === 'pay' ? current.changeWei : current.amountWei;
        mock.control.inject({ type: 'receipt-confirmed', card: current.card, operationId: current.operationId,
          outputId: current.outputId, amountWei: received });
      }
      if (current.requestId !== undefined) {
        store.rewards.markReceived(scope, current.requestId, current.outputId, identifier(counter, 5) as Bytes32);
        mock.control.inject({ type: 'reward-request', requestId: current.requestId, status: 'received', operationId: current.operationId });
      }
      flow = undefined;
      for (const listener of listeners) listener(snapshot());
      return;
    }
    current.stage += 1;
    if (current.card === 'withdraw' && current.stage === 3) {
      flow = undefined;
      for (const listener of listeners) listener(snapshot());
    }
  }

  function reset(): void {
    mock.dispose();
    store.control.reset();
    clock.set(0);
    mock = createMockUiController({ scope, clock, store, scenario: 'disconnected' });
    counter = 0;
    flow = undefined;
    recorded = [];
    attach();
    for (const listener of listeners) listener(snapshot());
  }

  const experience: MockExperience = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispatch: (action) => dispatch(action),
    advance: () => advance(),
    save: () => encodeSession(recorded),
    restore(serialized) {
      const steps = decodeSession(serialized);
      reset();
      return (async () => {
        for (const step of steps) {
          if (step.kind === 'action') await dispatch(step.action);
          else advance();
        }
        if (mock.snapshot().cards.pay.quote !== undefined) {
          mock.control.inject({ type: 'invalidate-quote' });
        }
      })();
    },
    reset,
    get mock() { return mock; },
    clock,
    store,
    dispose() { unsubscribe(); mock.dispose(); listeners.clear(); },
  };
  return experience;
}
