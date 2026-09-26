import { expect, it } from 'vitest';
import { inspectOperation } from '../src/recovery.js';
import type { RecoveryEvidence } from '../src/recovery.js';
import type { SavedReservation } from '../src/reservation.js';
import type { Scope } from '../src/domain.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'33'.repeat(32)}`;
const saved = (kind: 'pay' | 'withdraw' = 'pay', attemptIds: string[] = []): SavedReservation => ({
  record: {
    kind, scope, recordId: id, inputId: id, operationId: id,
    contentHash: id, encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    signatureStarted: true, attemptIds,
    ...(kind === 'pay' ? { paymentId: id, deadline: 600n } : {}),
  } as never,
  revision: 2,
  reservationState: 'active',
});

const evidence = (overrides: Partial<RecoveryEvidence> = {}): RecoveryEvidence => ({
  finalized: true, blockTime: 599n, paymentSucceeded: false,
  submissionKnownAbsent: true, attempts: [], storageAvailability: 'healthy',
  ...overrides,
});

it('resumes the original signed operation after a confirmed unsubmitted approval rejection', () => {
  expect(inspectOperation(saved(), evidence(), { state: 'unspent' }).action).toBe('resume-original');
  expect(inspectOperation(saved('pay', ['rejected']), evidence({
    attempts: [{ id: 'rejected', outcome: 'not-submitted' }],
  }), { state: 'unspent' }).action).toBe('resume-original');
});

it('rechecks when a lost submission response leaves execution unknown', () => {
  expect(inspectOperation(saved(), evidence({ submissionKnownAbsent: false }), { state: 'unspent' }).action).toBe('recheck');
});

it('does not retry while another attempt is pending or unknown', () => {
  const record = saved('pay', ['failed', 'pending']);
  expect(inspectOperation(record, evidence({ attempts: [
    { id: 'failed', outcome: 'finalized-failure' }, { id: 'pending', outcome: 'pending' },
  ] }), { state: 'unspent' }).action).toBe('recheck');
  expect(inspectOperation(record, evidence({ attempts: [
    { id: 'failed', outcome: 'finalized-failure' }, { id: 'pending', outcome: 'unknown' },
  ] }), { state: 'unspent' }).action).toBe('recheck');
});

it('does not accept duplicate evidence IDs in place of an unresolved attempt', () => {
  const record = saved('pay', ['first', 'second']);
  expect(inspectOperation(record, evidence({ attempts: [
    { id: 'first', outcome: 'finalized-failure' },
    { id: 'first', outcome: 'finalized-failure' },
  ] }), { state: 'unspent' }).action).toBe('recheck');
});

it('allows same-terms retry after every known attempt failed and the authorization is live', () => {
  expect(inspectOperation(saved('pay', ['failed']), evidence({
    attempts: [{ id: 'failed', outcome: 'finalized-failure' }],
  }), { state: 'unspent' }).action).toBe('retry-attempt');
});

it('requires finalized time strictly after the Pay deadline before changing conditions', () => {
  const atDeadline = evidence({ blockTime: 600n });
  expect(inspectOperation(saved(), atDeadline, { state: 'unspent' }).action).toBe('resume-original');
  expect(inspectOperation(saved(), evidence({ blockTime: 601n }), { state: 'unspent' }).action).toBe('change-terms');
  expect(inspectOperation(saved(), evidence({ finalized: false, blockTime: 601n }), { state: 'unspent' }).action).toBe('recheck');
});

it('blocks new authorization on a spent input and treats confirmed Pay success as complete', () => {
  expect(inspectOperation(saved(), evidence({ blockTime: 601n }), { state: 'spent' }).action).toBe('blocked');
  expect(inspectOperation(saved(), evidence({ paymentSucceeded: true }), { state: 'spent' }).action).toBe('complete');
});

it('never time-releases a full Withdraw', () => {
  expect(inspectOperation(saved('withdraw'), evidence({ blockTime: 999999n }), { state: 'unspent' }).action).toBe('resume-original');
});

it('stops on rollback, unavailable storage, missing attempts, and unknown input', () => {
  expect(inspectOperation(saved(), evidence({ storageAvailability: 'rollback' }), { state: 'unspent' }).action).toBe('recheck');
  expect(inspectOperation(saved(), evidence({ storageAvailability: 'unavailable' }), { state: 'unspent' }).action).toBe('recheck');
  expect(inspectOperation(saved('pay', ['lost']), evidence(), { state: 'unspent' }).action).toBe('recheck');
  expect(inspectOperation(saved(), evidence(), { state: 'unknown' }).action).toBe('recheck');
});
