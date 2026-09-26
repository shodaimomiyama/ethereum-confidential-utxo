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
  store.control.setUnavailable(false);
  expect(store.control.health()).toBe('rollback');
  expect(() => store.operations.put(record('pay'), 0)).toThrowError(/UNAVAILABLE/);
  store.control.setUnavailable(true);
  expect(store.control.health()).toBe('unavailable');
  store.control.setUnavailable(false);
  expect(store.control.health()).toBe('rollback');
  expect(() => store.operations.put(record('pay'), 0)).toThrowError(/UNAVAILABLE/);
});

it('does not mark a finalized reward as received during a rollback', () => {
  const store = createMemoryStore();
  const request = store.rewards.create(reward());
  store.control.setRewardFinalized(scope, request.requestId, inputId as never, id as never);
  store.control.simulateRollback();
  expect(() => store.rewards.markReceived(scope, request.requestId, inputId as never, id as never))
    .toThrowError(/UNAVAILABLE/);
  expect(store.rewards.get(scope, request.requestId)?.status).toBe('finalized');
  expect(store.control.journal().map((entry) => entry.kind)).not.toContain('reward-received');
});

it('never rewinds the fact that signing started or erases a known attempt', () => {
  const store = createMemoryStore();
  const original = record('pay');
  store.operations.put(original, 0);
  const signed = { ...original, signatureStarted: true, attemptIds: ['attempt-a' as never] };
  expect(store.operations.put(signed, 1).revision).toBe(2);
  expect(() => store.operations.put({ ...signed, signatureStarted: false }, 2)).toThrowError(/CONFLICT/);
  expect(() => store.operations.put({ ...signed, attemptIds: [] }, 2)).toThrowError(/CONFLICT/);
  expect(store.operations.list(scope)[0]?.record.attemptIds).toEqual(['attempt-a']);
});

it('cannot replace a reserved operation or payment under a later revision', () => {
  const store = createMemoryStore();
  const original = record('pay');
  store.operations.put(original, 0);
  expect(() => store.operations.put({ ...original, operationId: inputId as never }, 1)).toThrowError(/CONFLICT/);
  if (original.kind === 'pay') {
    expect(() => store.operations.put({ ...original, paymentId: inputId as never }, 1)).toThrowError(/CONFLICT/);
    expect(() => store.operations.put({ ...original, deadline: 601n }, 1)).toThrowError(/CONFLICT/);
  }
});

it('rejects reuse of a scoped record ID on another input', () => {
  const store = createMemoryStore();
  const original = record('pay');
  store.operations.put(original, 0);
  expect(() => store.operations.put({ ...original, inputId: `0x${'55'.repeat(32)}` as never }, 0)).toThrowError(/CONFLICT/);
  expect(store.operations.get(scope, original.recordId)?.record.inputId).toBe(original.inputId);
});

it('retains a released Pay and its encrypted revision after a later reservation', () => {
  const store = createMemoryStore();
  const original = record('pay');
  const first = store.operations.put(original, 0);
  const released = store.operations.applyCheckpoint(scope, original.recordId, {
    status: 'released',
    checkpoint: { blockNumber: '12', blockHash: id as never, blockTimestamp: '601' },
  });
  expect(released.revision).toBe(first.revision);
  expect(released.stateVersion).toBe(first.stateVersion + 1);

  const next = record('withdraw', `0x${'55'.repeat(32)}`);
  expect(store.operations.put(next, 0).record.recordId).toBe(next.recordId);
  expect(store.operations.list(scope).map(({ record: { recordId } }) => recordId)).toEqual([id, next.recordId]);
  expect(() => store.operations.put(original, 0)).not.toThrow();
  expect(store.operations.get(scope, next.recordId)?.status).toBe('reserved');
  store.operations.applyCheckpoint(scope, original.recordId, {
    status: 'released',
    checkpoint: { blockNumber: '13', blockHash: id as never, blockTimestamp: '602' },
  });
  expect(() => store.operations.put(record('pay', `0x${'66'.repeat(32)}`), 0)).toThrowError(/CONFLICT/);
});

it('pages all owned records without dropping the record after the first 100', () => {
  const store = createMemoryStore();
  for (let index = 1; index <= 101; index += 1) {
    const item = record('withdraw', `0x${index.toString(16).padStart(64, '0')}`);
    store.operations.put({
      ...item,
      inputId: `0x${(index + 1000).toString(16).padStart(64, '0')}` as never,
    }, 0);
  }
  const first = store.operations.listPage(scope);
  expect(first.records).toHaveLength(100);
  expect(first.nextCursor).toBe(`0x${(100).toString(16).padStart(64, '0')}`);
  const second = store.operations.listPage(scope, first.nextCursor);
  expect(second.records).toHaveLength(1);
  expect(second.nextCursor).toBeUndefined();
});
