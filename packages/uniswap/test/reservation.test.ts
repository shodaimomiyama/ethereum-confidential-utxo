import { expect, it } from 'vitest';
import { createMemoryReservationPort } from '../src/testing/reservation.js';
import type { Bytes32, Scope } from '../src/domain.js';
import type { OperationRecord } from '../src/storage.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const id = (byte: string) => `0x${byte.repeat(64)}` as Bytes32;
const blockHash = id('a');
const bundle = { ciphertext: 'AQID', nonce: `0x${'01'.repeat(12)}`, tag: `0x${'02'.repeat(16)}` };
const releaseRecord = () => ({ ...pay(), encryptedBundle: { ...bundle, nonce: `0x${'04'.repeat(12)}` } });

function pay(recordId = id('1'), inputId = id('2')): OperationRecord {
  return {
    kind: 'pay', recordId, inputId: inputId as never, scope,
    operationId: id('3') as never, paymentId: id('4') as never,
    contentHash: id('5'), encryptedBundle: bundle,
    deadline: 600n, signatureStarted: false, attemptIds: [],
  };
}

function withdraw(recordId = id('6'), inputId = id('2')): OperationRecord {
  const { paymentId: _paymentId, deadline: _deadline, ...base } = pay(recordId, inputId);
  return { ...base, kind: 'withdraw' } as OperationRecord;
}

it('reserves one input atomically against another Pay and full Withdraw', async () => {
  const port = createMemoryReservationPort();
  const first = await port.reserve(pay(), 0, 1);
  expect(first.revision).toBe(1);
  expect(await port.reserve(pay(), 0, 1)).toEqual(first);
  await expect(port.reserve(pay(id('7')), 0, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(port.reserve(withdraw(), 0, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('recovers the same record after a lost durable ACK', async () => {
  const port = createMemoryReservationPort();
  port.control.loseNextAck();
  await expect(port.reserve(pay(), 0, 1)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect((await port.get(scope, id('1')))?.revision).toBe(1);
  expect((await port.list(scope)).records).toHaveLength(1);
});

it('binds saved ciphertext to the next revision and keeps fixed conditions immutable', async () => {
  const port = createMemoryReservationPort();
  await expect(port.reserve(pay(), 0, 2)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await port.reserve(pay(), 0, 1);
  await expect(port.update({ ...pay(), signatureStarted: true }, 0, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(port.update({ ...pay(), contentHash: id('8') }, 1, 2)).rejects.toMatchObject({ code: 'CONFLICT' });
  const signed = { ...pay(), signatureStarted: true, encryptedBundle: { ...bundle, nonce: `0x${'03'.repeat(12)}` } };
  expect((await port.update(signed, 1, 2)).revision).toBe(2);
  await expect(port.update({ ...signed, signatureStarted: false }, 2, 3)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(port.update({ ...signed, encryptedBundle: bundle }, 2, 3)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('releases expired Pay only after the trusted finalized verifier confirms safe reuse', async () => {
  let time = 600n;
  let paymentSucceeded = false;
  let inputUnspent = true;
  const port = createMemoryReservationPort({ verify: async () => ({ finalized: true, blockTime: time, paymentSucceeded, inputUnspent, inputConsumed: !inputUnspent }) });
  await port.reserve(pay(), 0, 1);
  await expect(port.release(releaseRecord(), { blockHash }, 1, 2)).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
  time = 601n;
  paymentSucceeded = true;
  await expect(port.release(releaseRecord(), { blockHash }, 1, 2)).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
  paymentSucceeded = false;
  inputUnspent = false;
  await expect(port.release(releaseRecord(), { blockHash }, 1, 2)).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
  inputUnspent = true;
  expect((await port.release(releaseRecord(), { blockHash }, 1, 2)).reservationState).toBe('released');
  await port.reserve(pay(id('7')), 0, 1);
  expect((await port.list(scope)).records).toHaveLength(2);
});

it('never time-releases a full Withdraw', async () => {
  const port = createMemoryReservationPort({ verify: async () => ({ finalized: true, blockTime: 999999n, paymentSucceeded: false, inputUnspent: true, inputConsumed: false }) });
  await port.reserve(withdraw(), 0, 1);
  await expect(port.release({ ...withdraw(), encryptedBundle: { ...bundle, nonce: `0x${'04'.repeat(12)}` } }, { blockHash }, 1, 2)).rejects.toMatchObject({ code: 'NOT_FINALIZED' });
});

it('does not erase signing or attempt history while releasing a Pay reservation', async () => {
  const port = createMemoryReservationPort({ verify: async () => ({
    finalized: true, blockTime: 601n, paymentSucceeded: false, inputUnspent: true, inputConsumed: false,
  }) });
  await port.reserve(pay(), 0, 1);
  await port.update({ ...pay(), signatureStarted: true, attemptIds: ['first' as never], encryptedBundle: { ...bundle, nonce: `0x${'03'.repeat(12)}` } }, 1, 2);
  await expect(port.release(releaseRecord(), { blockHash }, 2, 3)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await port.get(scope, id('1')))?.record.signatureStarted).toBe(true);
});

it('stops new writes after rollback while distinguishing it from an empty healthy list', async () => {
  const port = createMemoryReservationPort();
  expect((await port.list(scope)).availability).toBe('healthy');
  port.control.simulateRollback();
  expect((await port.list(scope)).availability).toBe('rollback');
  await expect(port.reserve(pay(), 0, 1)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});

it('reports service unavailability instead of a healthy empty list', async () => {
  const port = createMemoryReservationPort();
  port.control.setUnavailable(true);
  await expect(port.list(scope)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(port.get(scope, id('1'))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(port.reserve(pay(), 0, 1)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});
