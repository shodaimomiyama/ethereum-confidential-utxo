import { expect, it } from 'vitest';
import { parseOperationRecord, parseRewardRequest } from '../src/api.js';
import { createMemoryStore } from '../src/testing/store.js';
import type { Scope } from '../src/domain.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const id = `0x${'33'.repeat(32)}`;
const inputId = `0x${'44'.repeat(32)}`;
const bundle = { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` };

function record(kind: 'pay' | 'withdraw', recordId = id) {
  return parseOperationRecord({
    recordId,
    kind,
    inputId,
    operationId: recordId,
    contentHash: recordId,
    encryptedBundle: bundle,
    signatureStarted: false,
    attemptIds: [],
    ...(kind === 'pay' ? { paymentId: recordId, deadline: '600' } : {}),
  }, scope);
}

function reward(requestId = id) {
  return parseRewardRequest({
    scope,
    requestId,
    amountWei: '1',
    recipientInfo: { owner, publicKey: inputId, signature: `0x${'aa'.repeat(65)}` },
  });
}

it('returns the same saved operation for an identical retry and rejects a competing Withdraw', () => {
  const store = createMemoryStore();
  const pay = record('pay');
  const first = store.operations.put(pay, 0);
  expect(first.revision).toBe(1);
  expect(store.operations.put(pay, 0)).toEqual(first);
  expect(() => store.operations.put(record('withdraw', `0x${'55'.repeat(32)}`), 0)).toThrowError(/CONFLICT/);
  expect(store.operations.list(scope)).toHaveLength(1);
});

it('does not release a Withdraw reservation when time passes or the record is edited', () => {
  const store = createMemoryStore();
  const withdraw = record('withdraw');
  store.operations.put(withdraw, 0);
  expect(() => store.operations.put({ ...withdraw, contentHash: inputId as never }, 1)).toThrowError(/CONFLICT/);
  expect(store.operations.list(scope)).toHaveLength(1);
});

it('stops new writes after record rollback while keeping known records readable', () => {
  const store = createMemoryStore();
  store.operations.put(record('pay'), 0);
  store.control.simulateRollback();
  expect(store.operations.list(scope)).toHaveLength(1);
  expect(() => store.operations.put(record('pay', `0x${'55'.repeat(32)}`), 0)).toThrowError(/UNAVAILABLE/);
  expect(() => store.rewards.create(reward())).toThrowError(/UNAVAILABLE/);
});

it('preserves request identity across retries and permits a new request only after receipt', () => {
  const store = createMemoryStore();
  const first = store.rewards.create(reward());
  expect(store.rewards.create(reward())).toEqual(first);
  expect(() => store.rewards.create(reward(`0x${'66'.repeat(32)}`))).toThrowError(/PENDING_REQUEST/);
  store.control.setRewardFinalized(scope, first.requestId, inputId as never, id as never);
  store.rewards.markReceived(scope, first.requestId, inputId as never, id as never);
  expect(store.rewards.create(reward(`0x${'66'.repeat(32)}`)).status).toBe('accepted');
});

it('keeps authorization stopped after a partially rolled back operation record', () => {
  const store = createMemoryStore();
  store.operations.put(record('pay'), 0);
  store.control.simulateRollback('partial');
  expect(store.operations.list(scope)).toHaveLength(0);
  expect(store.control.health()).toBe('rollback');
  expect(() => store.operations.put(record('pay'), 0)).toThrowError(/UNAVAILABLE/);
});
