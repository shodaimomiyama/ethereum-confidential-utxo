import { expect, it } from 'vitest';
import { createManualClock, createMemoryStore } from '@confidential-utxo/uniswap/testing';
import { parseOperationRecord } from '@confidential-utxo/uniswap';
import type { OperationId, Scope } from '@confidential-utxo/uniswap';
import { createMockUiController } from '../src/mock/controller.js';

const owner = `0x${'11'.repeat(20)}`;
const other = `0x${'22'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const operationId = `0x${'33'.repeat(32)}` as OperationId;
const outputId = `0x${'44'.repeat(32)}`;

function setup(scenario = 'ready') {
  const store = createMemoryStore();
  const clock = createManualClock(0);
  const ui = createMockUiController({ scope, store, clock, scenario });
  return { store, clock, ui };
}

it('blocks starting Pay when its result is unknown without creating an effect', async () => {
  const { store, ui } = setup('S-27/hash-unknown');
  const before = ui.control.journal().length;
  expect(await ui.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'blocked', reason: 'RESULT_UNKNOWN' });
  expect(ui.control.journal()).toHaveLength(before);
  expect(store.operations.list(scope)).toHaveLength(0);
  expect(ui.snapshot().allowedActions).toContain('recheck');
});

it('notifies a subscriber once per event and keeps older owner state separate', async () => {
  const { ui } = setup();
  const seen: string[] = [];
  const unsubscribe = ui.subscribe((snapshot) => seen.push(snapshot.scope.owner));
  ui.control.inject({ type: 'preparing', card: 'deposit' });
  expect(seen).toEqual([owner]);
  await ui.dispatch({ type: 'switch-scope', scope: { deploymentId: 'local-v1', owner: other } as Scope });
  expect(ui.snapshot().scope.owner).toBe(other);
  ui.control.inject({ type: 'unknown', card: 'pay', operationId, scope });
  expect(ui.snapshot().cards.pay.phase).not.toBe('unknown');
  unsubscribe();
  ui.dispose();
});

it('accepts quote age 30000ms and rejects 30001ms, negative age, or unknown age', async () => {
  const { ui, clock } = setup();
  ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 0 });
  clock.set(30000);
  expect((await ui.dispatch({ type: 'start', card: 'pay' })).kind).toBe('accepted');
  ui.control.reset('ready');
  ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 0 });
  clock.set(30001);
  expect(await ui.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'blocked', reason: 'QUOTE_STALE' });
  clock.set(-1);
  expect((await ui.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
  ui.control.reset('ready');
  expect((await ui.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
});

it('keeps finalized success separate from invalid receipt and counts valid change only once', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'finalized-success', card: 'pay', operationId, amountWei: 7n });
  expect(ui.snapshot().availablePrivateWei).toBe(0n);
  ui.control.inject({ type: 'receipt-invalid', card: 'pay', operationId });
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('finalized-success');
  expect(ui.snapshot().availablePrivateWei).toBe(0n);
  ui.control.inject({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 7n });
  ui.control.inject({ type: 'receipt-confirmed', card: 'pay', operationId, outputId, amountWei: 7n });
  expect(ui.snapshot().availablePrivateWei).toBe(7n);
  ui.control.inject({ type: 'reorg', card: 'pay', operationId });
  expect(ui.snapshot().availablePrivateWei).toBe(0n);
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('unknown');
});

it('allows retry only after other attempts, input state and deadline are checked', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: true, inputUnspent: true, deadlineValid: true });
  expect((await ui.dispatch({ type: 'retry-attempt', operationId })).kind).toBe('blocked');
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
  expect((await ui.dispatch({ type: 'retry-attempt', operationId })).kind).toBe('accepted');
  expect(ui.control.journal().filter((x) => x.kind === 'send')).toHaveLength(1);
});

it('requires reservation ACK before wallet approval and recheck never sends', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'preparing', card: 'pay' });
  ui.control.inject({ type: 'awaiting-approval', card: 'pay', purpose: 'pool-authorization' });
  expect(ui.snapshot().cards.pay.phase).toBe('preparing');
  ui.control.inject({ type: 'reservation-ack', card: 'pay' });
  ui.control.inject({ type: 'awaiting-approval', card: 'pay', purpose: 'pool-authorization' });
  expect(ui.snapshot().cards.pay.approvalPurpose).toBe('pool-authorization');
  ui.control.inject({ type: 'unknown', card: 'pay', operationId });
  await ui.dispatch({ type: 'recheck', operationId });
  expect(ui.control.journal().filter((x) => x.kind === 'send')).toHaveLength(0);
});

it('keeps the original signed operation available for first submission after proven non-submission', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'original-unsent', card: 'pay', operationId, inputUnspent: true, deadlineValid: true });
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('not-submitted');
  expect(await ui.dispatch({ type: 'resume-original', operationId })).toEqual({ kind: 'accepted' });
  expect(ui.control.journal().filter((x) => x.kind === 'send')).toHaveLength(1);
});

it('holds changed terms until the prior authorization is proven unusable', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: true });
  expect(await ui.dispatch({ type: 'confirm-terms', card: 'pay' })).toEqual({ kind: 'blocked', reason: 'AUTHORIZATION_ACTIVE' });
  ui.control.inject({ type: 'terms-changed', card: 'pay', oldAuthorizationActive: false });
  expect(await ui.dispatch({ type: 'confirm-terms', card: 'pay' })).toEqual({ kind: 'accepted' });
});

it('tracks two attempts under one operation and ignores a duplicate success', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, attemptId: 'attempt-a', otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
  ui.control.inject({ type: 'finalized-success', card: 'pay', operationId, attemptId: 'attempt-b' });
  ui.control.inject({ type: 'finalized-success', card: 'pay', operationId, attemptId: 'attempt-b' });
  expect(ui.snapshot().operations).toHaveLength(1);
  expect(ui.snapshot().operations[0]?.attemptIds).toEqual(['attempt-a', 'attempt-b']);
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('finalized-success');
});

it('stamps a recheck with the injected clock without submitting anything', async () => {
  const { ui, clock } = setup('S-27/hash-unknown');
  clock.set(123);
  await ui.dispatch({ type: 'recheck', operationId });
  expect(ui.snapshot().checkedAt).toBe(123);
  expect(ui.control.journal().filter((x) => x.kind === 'send')).toHaveLength(0);
});

it('does not use another operation’s retry permission', async () => {
  const { ui } = setup();
  const otherOperationId = `0x${'55'.repeat(32)}` as OperationId;
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
  ui.control.inject({ type: 'attempt-failed', card: 'withdraw', operationId: otherOperationId, otherAttemptPending: true, inputUnspent: true, deadlineValid: true });
  expect(await ui.dispatch({ type: 'retry-attempt', operationId: otherOperationId })).toEqual({ kind: 'blocked', reason: 'NOT_ALLOWED' });
  expect(ui.control.journal().filter((x) => x.kind === 'send')).toHaveLength(0);
});

it('exposes the fixed automatic minimum and deadline with the quote', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 10 });
  expect(ui.snapshot().cards.pay.quote).toEqual({
    startedAt: 0,
    quoteOut: 100n,
    minAmountOut: 99n,
    deadline: 610,
  });
  ui.control.inject({ type: 'quote', startedAt: 1, quoteOut: 1n, latestBlockTimestamp: 11 });
  expect(ui.snapshot().cards.pay.quote?.minAmountOut).toBe(1n);
});

it('passes a validation reason to the UI and prevents an invalid Pay start', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'validation-result', card: 'pay', phase: 'invalid-input', reason: 'INPUT_INVALID', input: { amount: '0' } });
  expect(ui.snapshot().cards.pay.input.amount).toBe('0');
  expect(ui.snapshot().cards.pay.reason).toBe('INPUT_INVALID');
  expect((await ui.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
});

it('shows finalized full Withdraw as complete without waiting for a change output', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'finalized-success', card: 'withdraw', operationId });
  expect(ui.snapshot().cards.withdraw.phase).toBe('complete');
  expect(ui.snapshot().operations[0]?.receiptState).toBe('none');
});

it('permits an explicit new reward start after owner receipt is confirmed', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'finalized-success', card: 'reward', operationId });
  ui.control.inject({ type: 'receipt-confirmed', card: 'reward', operationId, outputId, amountWei: 7n });
  expect(await ui.dispatch({ type: 'start', card: 'reward' })).toEqual({ kind: 'accepted' });
});

it('restores a shared pending reservation when a second client is created', async () => {
  const store = createMemoryStore();
  store.operations.put(parseOperationRecord({
    recordId: operationId,
    kind: 'pay',
    inputId: outputId,
    operationId,
    paymentId: operationId,
    deadline: '600',
    contentHash: operationId,
    encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    signatureStarted: true,
    attemptIds: [],
  }, scope), 0);
  const clock = createManualClock(0);
  const first = createMockUiController({ scope, store, clock, scenario: 'ready' });
  first.dispose();
  const second = createMockUiController({ scope, store, clock, scenario: 'ready' });
  expect(second.snapshot().operations[0]?.operationId).toBe(operationId);
  expect(second.snapshot().cards.pay.phase).toBe('unknown');
  expect((await second.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
});
