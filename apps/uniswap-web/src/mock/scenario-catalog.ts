import type { ChainOutcome, OperationId, ReceiptState, RequestId, Scope } from '@confidential-utxo/uniswap';
import type { ManualClock, MemoryStore, StoreSeed } from '@confidential-utxo/uniswap/testing';
import type { UiAction, UiController } from '../contracts/controller.js';
import type { Card, CardPhase, ValidationReason } from '../contracts/state.js';
import type { ScenarioControl, ScenarioEvent } from './controller.js';

const operationId = `0x${'33'.repeat(32)}` as OperationId;
const requestId = `0x${'66'.repeat(32)}` as RequestId;
const outputId = `0x${'44'.repeat(32)}`;
const txHash = `0x${'55'.repeat(32)}` as never;
const otherOwner = `0x${'22'.repeat(20)}`;
const defaultOwner = `0x${'11'.repeat(20)}`;

export type ScenarioStep =
  | { readonly kind: 'event'; readonly event: ScenarioEvent }
  | { readonly kind: 'action'; readonly action: UiAction; readonly result: 'accepted' | 'blocked' }
  | { readonly kind: 'clock'; readonly at: number };

export interface ExpectedSnapshot {
  readonly card: Card;
  readonly phase: CardPhase;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly chainOutcome?: ChainOutcome | 'none';
  readonly receiptState?: ReceiptState | 'none';
  readonly availablePrivateWei?: bigint;
  readonly reason?: ValidationReason;
  readonly input?: Readonly<Record<string, string>>;
  readonly knownHashes?: number;
  readonly owner?: string;
  readonly effects?: { readonly starts?: number; readonly sends?: number; readonly reservations?: number; readonly requests?: number };
}

export interface Scenario {
  readonly id: string;
  readonly specIds: readonly string[];
  readonly initialScenario: string;
  readonly seed: StoreSeed;
  readonly steps: readonly ScenarioStep[];
  readonly expected: ExpectedSnapshot;
}

const event = (value: ScenarioEvent): ScenarioStep => ({ kind: 'event', event: value });
const action = (value: UiAction, result: 'accepted' | 'blocked'): ScenarioStep => ({ kind: 'action', action: value, result });
const clock = (at: number): ScenarioStep => ({ kind: 'clock', at });

function scenario(
  id: string,
  steps: readonly ScenarioStep[],
  expected: ExpectedSnapshot,
  initialScenario = 'ready',
): Scenario {
  return { id, specIds: [id.split('/')[0] ?? id], initialScenario, seed: {}, steps, expected };
}

function invalid(id: string, card: Card, reason: ValidationReason, input: Record<string, string>): Scenario {
  return scenario(id, [event({ type: 'validation-result', card, phase: 'invalid-input', reason, input }),
    action({ type: 'start', card }, 'blocked')], {
    card, phase: 'invalid-input', allowedActions: [`edit:${card}`], forbiddenActions: [`start:${card}`],
    reason, input,
  });
}

function preparation(id: string, card: Card, reason: ValidationReason): Scenario {
  return scenario(id, [event({ type: 'validation-result', card, phase: 'needs-preparation', reason }),
    action({ type: 'start', card }, 'blocked')], {
    card, phase: 'needs-preparation', allowedActions: [`edit:${card}`], forbiddenActions: [`start:${card}`], reason,
  });
}

const quote = event({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 10 });

export const scenarios: readonly Scenario[] = [
  scenario('S-25/retry-after-only-failed-attempt', [event({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true }), action({ type: 'retry-attempt', operationId }, 'accepted')], { card: 'pay', phase: 'failed', chainOutcome: 'finalized-failure', allowedActions: ['recheck'], forbiddenActions: ['retry-attempt', 'start:pay'], effects: { sends: 1 } }),
  scenario('S-25/other-attempt-pending', [event({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: true, inputUnspent: true, deadlineValid: true }), action({ type: 'retry-attempt', operationId }, 'blocked')], { card: 'pay', phase: 'pending', chainOutcome: 'pending', allowedActions: ['recheck'], forbiddenActions: ['retry-attempt', 'start:pay'] }),
  scenario('S-26/old-authorization-active', [event({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: true }), action({ type: 'confirm-terms', card: 'pay' }, 'blocked')], { card: 'pay', phase: 'confirm-terms', allowedActions: ['edit:pay'], forbiddenActions: ['confirm-terms'], reason: 'AUTHORIZATION_ACTIVE' }),
  scenario('S-26/old-authorization-unusable', [event({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: false }), action({ type: 'confirm-terms', card: 'pay' }, 'accepted')], { card: 'pay', phase: 'preparing', allowedActions: ['resync'], forbiddenActions: ['confirm-terms'] }),
  scenario('S-27/pending', [event({ type: 'submitted', card: 'pay', operationId }), action({ type: 'start', card: 'pay' }, 'blocked')], { card: 'pay', phase: 'pending', chainOutcome: 'pending', allowedActions: ['recheck'], forbiddenActions: ['start:pay', 'retry-attempt'], knownHashes: 0 }),
  scenario('S-27/hash-unknown', [event({ type: 'unknown', card: 'pay', operationId }), action({ type: 'start', card: 'pay' }, 'blocked'), action({ type: 'recheck', operationId }, 'accepted')], { card: 'pay', phase: 'unknown', chainOutcome: 'unknown', allowedActions: ['recheck'], forbiddenActions: ['start:pay', 'retry-attempt'], knownHashes: 0 }),
  scenario('S-27/rpc-down', [event({ type: 'unknown', card: 'pay', operationId }), action({ type: 'retry-attempt', operationId }, 'blocked')], { card: 'pay', phase: 'unknown', chainOutcome: 'unknown', allowedActions: ['recheck'], forbiddenActions: ['start:pay', 'retry-attempt'] }),
  scenario('S-28/decryption-failed', [event({ type: 'finalized-success', card: 'pay', operationId }), event({ type: 'receipt-invalid', card: 'pay', operationId })], { card: 'pay', phase: 'receipt-invalid', chainOutcome: 'finalized-success', receiptState: 'invalid', availablePrivateWei: 0n, allowedActions: ['recheck', 'acknowledge-receipt'], forbiddenActions: ['start:pay'] }),
  scenario('S-28/owner-or-amount-mismatch', [event({ type: 'finalized-success', card: 'pay', operationId }), event({ type: 'receipt-invalid', card: 'pay', operationId })], { card: 'pay', phase: 'receipt-invalid', chainOutcome: 'finalized-success', receiptState: 'invalid', availablePrivateWei: 0n, allowedActions: ['recheck'], forbiddenActions: ['start:pay'] }),
  scenario('S-29/reorg-removes-adopted-change', [event({ type: 'finalized-success', card: 'pay', operationId }), event({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 7n }), event({ type: 'reorg', card: 'pay', operationId })], { card: 'pay', phase: 'unknown', chainOutcome: 'unknown', receiptState: 'none', availablePrivateWei: 0n, allowedActions: ['recheck'], forbiddenActions: ['start:pay'] }),
  scenario('S-30/duplicate-history', [event({ type: 'finalized-success', card: 'pay', operationId }), event({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 7n }), event({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 7n })], { card: 'pay', phase: 'complete', chainOutcome: 'finalized-success', receiptState: 'confirmed', availablePrivateWei: 7n, allowedActions: ['resync'], forbiddenActions: ['start:pay'] }),
  preparation('S-31/wrong-network', 'deposit', 'WRONG_NETWORK'),
  preparation('S-31/key-not-ready', 'reward', 'KEY_REQUIRED'),
  preparation('S-31/gas-shortage', 'deposit', 'GAS_REQUIRED'),
  scenario('S-32/revisit-and-resync', [action({ type: 'resync' }, 'accepted')], { card: 'pay', phase: 'ready', allowedActions: ['resync'], forbiddenActions: ['start:pay'] }),
  invalid('S-33/no-single-utxo', 'pay', 'NO_SINGLE_INPUT', { amount: '3' }),
  scenario('S-33/multiple-candidates', [quote, action({ type: 'start', card: 'pay' }, 'accepted')], { card: 'pay', phase: 'preparing', allowedActions: ['resync'], forbiddenActions: ['start:pay'], effects: { starts: 1 } }),
  scenario('S-34/quote-changed-before-authorization', [quote, event({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: false }), event({ type: 'quote', startedAt: 1, quoteOut: 200n, latestBlockTimestamp: 11 })], { card: 'pay', phase: 'confirm-terms', allowedActions: ['confirm-terms'], forbiddenActions: ['start:pay'] }),
  scenario('S-34/quote-changed-during-authorization', [quote, event({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: true }), event({ type: 'quote', startedAt: 1, quoteOut: 200n, latestBlockTimestamp: 11 })], { card: 'pay', phase: 'confirm-terms', allowedActions: ['edit:pay'], forbiddenActions: ['confirm-terms'] }),
  invalid('S-35/empty-amount', 'pay', 'INVALID_DECIMAL', { amount: '' }),
  invalid('S-35/invalid-format', 'pay', 'INVALID_DECIMAL', { amount: '1e3' }),
  invalid('S-35/unsupported-recipient', 'pay', 'UNSUPPORTED_RECIPIENT', { recipient: '0x0' }),
  preparation('S-35/gas-shortage', 'pay', 'GAS_REQUIRED'),
  scenario('S-35/quote-age-equal', [quote, clock(30000), action({ type: 'start', card: 'pay' }, 'accepted')], { card: 'pay', phase: 'preparing', allowedActions: ['resync'], forbiddenActions: ['start:pay'], effects: { starts: 1 } }),
  scenario('S-35/quote-age-exceeded', [quote, clock(30001), action({ type: 'start', card: 'pay' }, 'blocked')], { card: 'pay', phase: 'ready', allowedActions: ['edit:pay'], forbiddenActions: ['start:pay'] }),
  scenario('S-35/clock-backwards', [quote, clock(-1), action({ type: 'start', card: 'pay' }, 'blocked')], { card: 'pay', phase: 'ready', allowedActions: ['edit:pay'], forbiddenActions: ['start:pay'] }),
  scenario('S-35/clock-unmeasurable', [quote, clock(Number.NaN), action({ type: 'start', card: 'pay' }, 'blocked')], { card: 'pay', phase: 'ready', allowedActions: ['edit:pay'], forbiddenActions: ['start:pay'] }),
  scenario('S-36/self-recipient', [event({ type: 'validation-result', card: 'pay', phase: 'ready', input: { recipient: `0x${'11'.repeat(20)}` } }), quote, action({ type: 'start', card: 'pay' }, 'accepted')], { card: 'pay', phase: 'preparing', input: { recipient: `0x${'11'.repeat(20)}` }, allowedActions: ['resync'], forbiddenActions: ['start:pay'], effects: { starts: 1 } }),
  scenario('S-37/signed-but-never-submitted', [event({ type: 'original-unsent', card: 'pay', operationId, inputUnspent: true, deadlineValid: true }), action({ type: 'resume-original', operationId }, 'accepted')], { card: 'pay', phase: 'ready', chainOutcome: 'not-submitted', allowedActions: ['resync'], forbiddenActions: ['resume-original'], effects: { sends: 1 } }),
  scenario('S-37/send-unknown', [event({ type: 'unknown', card: 'pay', operationId }), action({ type: 'resume-original', operationId }, 'blocked')], { card: 'pay', phase: 'unknown', chainOutcome: 'unknown', allowedActions: ['recheck'], forbiddenActions: ['resume-original', 'start:pay'] }),
  scenario('S-38/full-withdraw-success', [event({ type: 'finalized-success', card: 'withdraw', operationId })], { card: 'withdraw', phase: 'complete', chainOutcome: 'finalized-success', receiptState: 'none', availablePrivateWei: 0n, allowedActions: ['resync'], forbiddenActions: ['start:withdraw'] }),
  scenario('S-38/receiver-rejected', [event({ type: 'attempt-failed', card: 'withdraw', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true })], { card: 'withdraw', phase: 'failed', chainOutcome: 'finalized-failure', allowedActions: ['recheck'], forbiddenActions: ['start:withdraw'] }),
  scenario('S-39/hash-not-yet-known', [event({ type: 'submitted', card: 'deposit', operationId })], { card: 'deposit', phase: 'pending', chainOutcome: 'pending', knownHashes: 0, allowedActions: ['recheck'], forbiddenActions: ['start:deposit'] }),
  scenario('S-39/hash-known', [event({ type: 'submitted', card: 'deposit', operationId, txHash })], { card: 'deposit', phase: 'pending', chainOutcome: 'pending', knownHashes: 1, allowedActions: ['recheck'], forbiddenActions: ['start:deposit'] }),
  scenario('S-39/pay-hash-known', [event({ type: 'submitted', card: 'pay', operationId, txHash })], { card: 'pay', phase: 'pending', chainOutcome: 'pending', knownHashes: 1, allowedActions: ['recheck'], forbiddenActions: ['start:pay'] }),
  scenario('S-39/reward-hash-known', [event({ type: 'submitted', card: 'reward', operationId, txHash })], { card: 'reward', phase: 'pending', chainOutcome: 'pending', knownHashes: 1, allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  scenario('S-39/withdraw-hash-known', [event({ type: 'submitted', card: 'withdraw', operationId, txHash })], { card: 'withdraw', phase: 'pending', chainOutcome: 'pending', knownHashes: 1, allowedActions: ['recheck'], forbiddenActions: ['start:withdraw'] }),
  invalid('S-40/coming-soon', 'pay', 'UNSUPPORTED', { feature: 'multi-input' }),
  scenario('S-41/request-in-progress', [event({ type: 'reward-request', requestId, status: 'accepted', operationId }), event({ type: 'submitted', card: 'reward', operationId }), action({ type: 'start', card: 'reward' }, 'blocked')], { card: 'reward', phase: 'pending', chainOutcome: 'pending', allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  scenario('S-42/reward-ack-lost', [event({ type: 'unknown', card: 'reward', operationId }), action({ type: 'start', card: 'reward' }, 'blocked')], { card: 'reward', phase: 'unknown', chainOutcome: 'unknown', allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  scenario('S-43/reward-finalized-receipt-invalid', [event({ type: 'finalized-success', card: 'reward', operationId }), event({ type: 'receipt-invalid', card: 'reward', operationId }), action({ type: 'start', card: 'reward' }, 'blocked')], { card: 'reward', phase: 'receipt-invalid', chainOutcome: 'finalized-success', receiptState: 'invalid', allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  scenario('S-44/new-explicit-same-amount-request', [event({ type: 'finalized-success', card: 'reward', operationId }), event({ type: 'receipt-confirmed', card: 'reward', operationId, outputId, amountWei: 7n }), action({ type: 'start', card: 'reward' }, 'accepted')], { card: 'reward', phase: 'preparing', chainOutcome: 'finalized-success', receiptState: 'confirmed', availablePrivateWei: 7n, allowedActions: ['resync'], forbiddenActions: ['start:reward'], effects: { starts: 1 } }),
  invalid('S-45/invalid-reward-amount', 'reward', 'INVALID_DECIMAL', { amount: '0' }),
  preparation('S-45/distributor-out-of-funds', 'reward', 'INSUFFICIENT_FUNDS'),
  scenario('S-45/distribution-attempt-failed', [event({ type: 'attempt-failed', card: 'reward', operationId, otherAttemptPending: true, inputUnspent: true, deadlineValid: true })], { card: 'reward', phase: 'pending', chainOutcome: 'pending', allowedActions: ['recheck'], forbiddenActions: ['start:reward', 'retry-attempt'] }),
  invalid('S-46/changed-request-contents', 'reward', 'REWARD_DUPLICATE', { amount: '2' }),
  scenario('S-46/distribution-end-unknown', [event({ type: 'unknown', card: 'reward', operationId }), action({ type: 'start', card: 'reward' }, 'blocked')], { card: 'reward', phase: 'unknown', chainOutcome: 'unknown', allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  scenario('S-47/scope-switch-hides-older-owner', [action({ type: 'switch-scope', scope: { deploymentId: 'local-v1', owner: otherOwner } as Scope }, 'accepted'), event({ type: 'unknown', card: 'reward', operationId, scope: { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope })], { card: 'reward', phase: 'ready', owner: otherOwner, allowedActions: ['start:reward'], forbiddenActions: ['recheck'] }),
  scenario('S-48/reward-reorg', [event({ type: 'finalized-success', card: 'reward', operationId }), event({ type: 'receipt-confirmed', card: 'reward', operationId, outputId, amountWei: 7n }), event({ type: 'reorg', card: 'reward', operationId })], { card: 'reward', phase: 'unknown', chainOutcome: 'unknown', receiptState: 'none', availablePrivateWei: 0n, allowedActions: ['recheck'], forbiddenActions: ['start:reward'] }),
  invalid('S-03/zero-or-negative-pay', 'pay', 'INVALID_DECIMAL', { amount: '0' }),
  invalid('S-03/precision-overflow', 'pay', 'INVALID_DECIMAL', { amount: '0.0000000000000000001' }),
  invalid('S-04/full-input-pay', 'pay', 'INPUT_INVALID', { amount: '10', inputAmount: '10' }),
  invalid('S-04/multiple-input-pay', 'pay', 'UNSUPPORTED', { inputs: '2' }),
  scenario('S-05/positive-one-wei-change', [event({ type: 'finalized-success', card: 'pay', operationId }), event({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 1n })], { card: 'pay', phase: 'complete', chainOutcome: 'finalized-success', receiptState: 'confirmed', availablePrivateWei: 1n, allowedActions: ['resync'], forbiddenActions: ['start:pay'] }),
  invalid('S-06/input-already-used', 'pay', 'INPUT_USED', { inputId: outputId }),
  invalid('S-07/minimum-zero', 'pay', 'INVALID_DECIMAL', { minAmountOut: '0' }),
  invalid('S-07/minimum-fraction', 'pay', 'INVALID_DECIMAL', { minAmountOut: '1.5' }),
  scenario('S-08/minimum-not-met', [event({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true })], { card: 'pay', phase: 'failed', chainOutcome: 'finalized-failure', allowedActions: ['recheck'], forbiddenActions: ['start:pay'] }),
  scenario('S-08/minimum-equal', [event({ type: 'finalized-success', card: 'pay', operationId })], { card: 'pay', phase: 'confirmed-receipt-pending', chainOutcome: 'finalized-success', receiptState: 'pending', allowedActions: ['acknowledge-receipt'], forbiddenActions: ['start:pay'] }),
  scenario('S-08/minimum-exceeded', [event({ type: 'finalized-success', card: 'pay', operationId })], { card: 'pay', phase: 'confirmed-receipt-pending', chainOutcome: 'finalized-success', receiptState: 'pending', allowedActions: ['acknowledge-receipt'], forbiddenActions: ['start:pay'] }),
];

export interface ScenarioHarness {
  readonly controller: UiController;
  readonly driver: ScenarioControl;
  readonly clock: ManualClock;
  readonly store: MemoryStore;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  const stringify = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  if (stringify(actual) !== stringify(expected)) {
    throw new Error(`${label}: expected ${stringify(expected)}, got ${stringify(actual)}`);
  }
}

export async function runUiScenario(scenarioCase: Scenario, harness: ScenarioHarness): Promise<void> {
  const { controller, driver, clock: testClock, store } = harness;
  for (const step of scenarioCase.steps) {
    if (step.kind === 'event') driver.inject(step.event);
    else if (step.kind === 'clock') testClock.set(step.at);
    else equal((await controller.dispatch(step.action)).kind, step.result, `${scenarioCase.id} action`);
  }
  const snapshot = controller.snapshot();
  const expected = scenarioCase.expected;
  equal(snapshot.cards[expected.card].phase, expected.phase, `${scenarioCase.id} phase`);
  equal(snapshot.scope.owner, expected.owner ?? defaultOwner, `${scenarioCase.id} owner`);
  equal(snapshot.publicEthWei, 0n, `${scenarioCase.id} public balance`);
  equal(snapshot.availablePrivateWei, expected.availablePrivateWei ?? 0n, `${scenarioCase.id} private balance`);
  equal(snapshot.pendingPrivateWei, 0n, `${scenarioCase.id} pending balance`);
  if (expected.reason !== undefined) equal(snapshot.cards[expected.card].reason, expected.reason, `${scenarioCase.id} reason`);
  if (expected.input !== undefined) equal(snapshot.cards[expected.card].input, expected.input, `${scenarioCase.id} input`);
  if (expected.chainOutcome !== undefined) {
    equal(snapshot.operations[0]?.chainOutcome ?? 'none', expected.chainOutcome, `${scenarioCase.id} outcome`);
  }
  if (expected.receiptState !== undefined) {
    equal(snapshot.operations[0]?.receiptState ?? 'none', expected.receiptState, `${scenarioCase.id} receipt`);
  }
  if (expected.knownHashes !== undefined) {
    equal(snapshot.operations[0]?.txHashes.length ?? 0, expected.knownHashes, `${scenarioCase.id} hash count`);
  }
  for (const allowed of expected.allowedActions) {
    if (!snapshot.allowedActions.includes(allowed)) throw new Error(`${scenarioCase.id}: missing allowed action ${allowed}`);
  }
  for (const forbidden of expected.forbiddenActions) {
    if (snapshot.allowedActions.includes(forbidden)) throw new Error(`${scenarioCase.id}: forbidden action ${forbidden}`);
  }
  const effects = expected.effects ?? {};
  equal(driver.journal().filter((entry) => entry.kind === 'start').length, effects.starts ?? 0, `${scenarioCase.id} starts`);
  equal(driver.journal().filter((entry) => entry.kind === 'send').length, effects.sends ?? 0, `${scenarioCase.id} sends`);
  equal(store.control.journal().filter((entry) => entry.kind === 'operation-put').length, effects.reservations ?? 0, `${scenarioCase.id} reservations`);
  equal(store.control.journal().filter((entry) => entry.kind === 'reward-create').length, effects.requests ?? 0, `${scenarioCase.id} requests`);
  controller.dispose();
}

export async function assertUiConformance(factory: (scenarioCase: Scenario) => ScenarioHarness | Promise<ScenarioHarness>): Promise<void> {
  for (const scenarioCase of scenarios) await runUiScenario(scenarioCase, await factory(scenarioCase));
}
