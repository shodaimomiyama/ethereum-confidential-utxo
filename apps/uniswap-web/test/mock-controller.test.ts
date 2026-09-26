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

for (const availability of ['unavailable', 'rollback'] as const) {
  for (const actionType of ['retry-attempt', 'resume-original'] as const) {
    it(`blocks ${actionType} while storage is ${availability} without sending`, async () => {
      const { ui, store } = setup();
      if (actionType === 'retry-attempt') {
        ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
      } else {
        ui.control.inject({ type: 'original-unsent', card: 'pay', operationId, inputUnspent: true, deadlineValid: true });
      }
      expect(ui.snapshot().allowedActions).toContain(actionType);

      if (availability === 'unavailable') store.control.setUnavailable(true);
      else store.control.simulateRollback('partial');

      expect(ui.snapshot().allowedActions).not.toContain(actionType);
      expect(await ui.dispatch({ type: actionType, operationId })).toEqual({ kind: 'blocked', reason: 'SERVICE_UNAVAILABLE' });
      expect(ui.control.journal().filter((entry) => entry.kind === 'send')).toHaveLength(0);

      if (availability === 'unavailable') {
        store.control.setUnavailable(false);
        expect(ui.snapshot().allowedActions).toContain(actionType);
        expect(await ui.dispatch({ type: actionType, operationId })).toEqual({ kind: 'accepted' });
        expect(ui.control.journal().filter((entry) => entry.kind === 'send')).toHaveLength(1);
      }
    });
  }
}

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

it('shows disconnected preparation without an active wallet scope', () => {
  const { ui } = setup('disconnected');
  expect(ui.snapshot().connection).toBe('disconnected');
  expect(ui.snapshot().currentScope).toBeUndefined();
  expect(ui.snapshot().preparation.wallet).toBe(false);
  expect(ui.snapshot().allowedActions).not.toContain('start:reward');
});

it('blocks Pay when combined UTXOs cover the amount but no single one does', async () => {
  const { ui } = setup('interactive');
  ui.control.inject({ type: 'preparation', wallet: true, network: true, key: true, faucet: true, gas: true });
  ui.control.inject({ type: 'utxos', utxos: [
    { id: `0x${'01'.repeat(32)}`, amountWei: 2n * 10n ** 18n, available: true },
    { id: `0x${'02'.repeat(32)}`, amountWei: 2n * 10n ** 18n, available: true },
  ] });
  await ui.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '3' });
  expect(ui.snapshot().cards.pay.reason).toBe('NO_SINGLE_INPUT');
  expect(await ui.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'blocked', reason: 'NO_SINGLE_INPUT' });
  expect(ui.control.journal().filter((entry) => entry.kind === 'start')).toHaveLength(0);
});

it('selects the smallest eligible UTXO and the lower ID on equal amounts', async () => {
  const { ui } = setup('interactive');
  ui.control.inject({ type: 'utxos', utxos: [
    { id: `0x${'03'.repeat(32)}`, amountWei: 4n * 10n ** 18n, available: true },
    { id: `0x${'02'.repeat(32)}`, amountWei: 4n * 10n ** 18n, available: true },
    { id: `0x${'01'.repeat(32)}`, amountWei: 5n * 10n ** 18n, available: true },
  ] });
  await ui.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '3' });
  expect(ui.snapshot().selectedInput.pay).toEqual({
    id: `0x${'02'.repeat(32)}`, amountWei: 4n * 10n ** 18n, changeWei: 1n * 10n ** 18n,
  });
});

it('keeps unrelated UTXOs when one operation is removed by reorganization', () => {
  const { ui } = setup('interactive');
  const unrelatedId = `0x${'99'.repeat(32)}`;
  ui.control.inject({ type: 'utxos', utxos: [{ id: unrelatedId, amountWei: 5n, available: true }] });
  ui.control.inject({ type: 'finalized-success', card: 'reward', operationId });
  ui.control.inject({ type: 'receipt-confirmed', card: 'reward', operationId, outputId, amountWei: 7n });
  ui.control.inject({ type: 'reorg', card: 'reward', operationId });
  expect(ui.snapshot().utxos).toEqual([{ id: unrelatedId, amountWei: 5n, available: true }]);
  expect(ui.snapshot().availablePrivateWei).toBe(5n);
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

it('revokes retry and resume when later evidence becomes unknown, successful, or reorganized', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
  ui.control.inject({ type: 'unknown', card: 'pay', operationId });
  expect((await ui.dispatch({ type: 'retry-attempt', operationId })).kind).toBe('blocked');
  ui.control.inject({ type: 'original-unsent', card: 'pay', operationId, inputUnspent: true, deadlineValid: true });
  ui.control.inject({ type: 'finalized-success', card: 'pay', operationId });
  expect((await ui.dispatch({ type: 'resume-original', operationId })).kind).toBe('blocked');
  ui.control.inject({ type: 'reorg', card: 'pay', operationId });
  expect((await ui.dispatch({ type: 'retry-attempt', operationId })).kind).toBe('blocked');
  expect(ui.control.journal().filter((entry) => entry.kind === 'send')).toHaveLength(0);
});

it('keeps a known logical success when an older attempt fails later', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'finalized-success', card: 'pay', operationId, attemptId: 'newer' });
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, attemptId: 'older', otherAttemptPending: false, inputUnspent: true, deadlineValid: true });
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('finalized-success');
  expect(ui.snapshot().cards.pay.phase).toBe('confirmed-receipt-pending');
  expect(ui.snapshot().allowedActions).not.toContain('retry-attempt');
});

it('does not call a logical operation failed while another attempt is pending', () => {
  const { ui } = setup();
  ui.control.inject({ type: 'attempt-failed', card: 'pay', operationId, otherAttemptPending: true, inputUnspent: true, deadlineValid: true });
  expect(ui.snapshot().operations[0]?.chainOutcome).toBe('pending');
});

it('blocks starts after a partial rollback or unavailable store', async () => {
  const { ui, store } = setup();
  store.control.simulateRollback('partial');
  await ui.dispatch({ type: 'resync' });
  expect(ui.snapshot().storageAvailability).toBe('rollback');
  expect((await ui.dispatch({ type: 'start', card: 'reward' })).kind).toBe('blocked');
  store.control.setUnavailable(true);
  await ui.dispatch({ type: 'resync' });
  expect((await ui.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
});

it('rehydrates an accepted reward request without an operation ID', async () => {
  const { ui, store, clock } = setup();
  const requestId = operationId as never;
  store.rewards.create({ scope, requestId, amountWei: 1n, recipientInfo: {
    owner: scope.owner, publicKey: outputId as never, signature: `0x${'aa'.repeat(65)}`,
  } });
  ui.dispose();
  const recreated = createMockUiController({ scope, store, clock, scenario: 'ready' });
  expect(recreated.snapshot().rewardRequests[0]?.requestId).toBe(requestId);
  expect((await recreated.dispatch({ type: 'start', card: 'reward' })).kind).toBe('blocked');
  expect((await recreated.dispatch({ type: 'recheck-reward', requestId })).kind).toBe('accepted');
});

it('holds an authorized quote while exposing changed proposed terms', async () => {
  const { ui } = setup();
  ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 10 });
  ui.control.inject({ type: 'reservation-ack', card: 'pay' });
  ui.control.inject({ type: 'awaiting-approval', card: 'pay', purpose: 'payment-authorization' });
  ui.control.inject({ type: 'quote', startedAt: 1, quoteOut: 200n, latestBlockTimestamp: 11 });
  expect(ui.snapshot().cards.pay.quote?.quoteOut).toBe(100n);
  expect(ui.snapshot().cards.pay.proposedQuote?.quoteOut).toBe(200n);
  expect(ui.snapshot().cards.pay.phase).toBe('confirm-terms');
  expect((await ui.dispatch({ type: 'confirm-terms', card: 'pay' })).kind).toBe('blocked');
});
