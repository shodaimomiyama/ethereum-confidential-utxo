import { expect, it } from 'vitest';
import { createPaymentClient } from '../src/process.js';
import type { PreparedPay, PaymentPorts } from '../src/process.js';
import type { RecoveryEvidence } from '../src/recovery.js';
import { createMemoryReservationPort } from '../src/testing/reservation.js';
import { parseOperationRecord } from '../src/api.js';
import type { Scope } from '../src/domain.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const recordId = `0x${'22'.repeat(32)}`;
const inputId = `0x${'33'.repeat(32)}`;
const blockHash = `0x${'44'.repeat(32)}`;
const record = parseOperationRecord({
  kind: 'pay', recordId, inputId, operationId: recordId,
  paymentId: recordId, contentHash: blockHash,
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
  deadline: '600', signatureStarted: false, attemptIds: [],
}, scope);

function setup() {
  const calls: string[] = [];
  const sealedHashes: string[] = [];
  const reservations = createMemoryReservationPort();
  let currentScope = scope;
  let now = 0;
  let attemptNumber = 0;
  let refreshChanges = false;
  const prepared: PreparedPay = {
    record, privateBytes: new Uint8Array([1, 2]), poolAuthorization: { operationId: record.operationId },
    quote: { startedAtMs: 0, blockHash: blockHash as never, blockNumber: 1n, inputWei: 1n, quoteOut: 99n },
  };
  const ports: PaymentPorts = {
    reservations: {
      ...reservations,
      reserve: async (...args) => { calls.push('reserve'); return reservations.reserve(...args); },
      update: async (...args) => { calls.push('update'); return reservations.update(...args); },
      get: async (...args) => { calls.push('get'); return reservations.get(...args); },
    },
    preparePay: async () => { calls.push('prepare'); return prepared; },
    prepareFullWithdraw: async () => { throw new Error('unused'); },
    validatePrepared: async () => {},
    refreshPay: async (old) => { calls.push('refresh'); return refreshChanges
      ? { ...old, record: { ...old.record, contentHash: `0x${'55'.repeat(32)}` as never } }
      : { ...old, quote: { ...old.quote, startedAtMs: now } }; },
    currentScope: () => currentScope,
    clock: { now: () => now },
    latestBlockTime: async () => 100n,
    encrypt: async (_data, context) => {
      calls.push(`encrypt:${context.revision}`);
      return { ciphertext: 'AQID', nonce: `0x${String(context.revision).padStart(2, '0').repeat(12)}`, tag: `0x${'01'.repeat(16)}` };
    },
    sealContent: (_prepared, _signatures, _attemptId, txHash) => {
      if (txHash !== undefined) sealedHashes.push(txHash);
      return new Uint8Array([1, 2, 3]);
    },
    signPool: async () => { calls.push('sign-pool'); return '0x11'; },
    signPayment: async () => { calls.push('sign-payment'); return '0x22'; },
    createAttempt: () => { calls.push('create-attempt'); attemptNumber += 1; return `attempt-${attemptNumber}` as never; },
    submit: async () => { calls.push('submit'); return { kind: 'submitted', txHash: blockHash as never }; },
  };
  return {
    calls, sealedHashes, reservations, prepared, ports,
    setNow: (value: number) => { now = value; },
    switchScope: () => { currentScope = { ...scope, owner: `0x${'66'.repeat(20)}` as never }; },
    changeRefresh: () => { refreshChanges = true; },
  };
}

it('prepares before reservation and signs only after both durable ACKs', async () => {
  const fixture = setup();
  const client = createPaymentClient(fixture.ports);
  const prepared = await client.preparePay('1');
  const result = await client.authorizePay(prepared, prepared.record.contentHash);
  expect(result.chainOutcome).toBe('pending');
  expect(fixture.calls).toEqual([
    'prepare', 'encrypt:1', 'reserve', 'encrypt:2', 'update',
    'sign-pool', 'sign-payment', 'encrypt:3', 'update',
    'create-attempt', 'encrypt:4', 'update', 'submit', 'encrypt:5', 'update',
  ]);
  expect(fixture.sealedHashes).toEqual([blockHash]);
  expect((await fixture.reservations.get(scope, record.recordId))?.record.signatureStarted).toBe(true);
});

it('keeps the wallet closed when the reservation service is unavailable', async () => {
  const fixture = setup();
  fixture.reservations.control.setUnavailable(true);
  const client = createPaymentClient(fixture.ports);
  const prepared = await client.preparePay('1');
  await expect(client.authorizePay(prepared, prepared.record.contentHash)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(fixture.calls).not.toContain('sign-pool');
  expect(fixture.calls).not.toContain('sign-payment');
});

it('requires renewed confirmation when a stale quote changes the fixed conditions', async () => {
  const fixture = setup();
  fixture.setNow(30_001);
  fixture.changeRefresh();
  const client = createPaymentClient(fixture.ports);
  await expect(client.authorizePay(fixture.prepared, fixture.prepared.record.contentHash)).rejects.toMatchObject({ code: 'TERMS_CHANGED' });
  expect(fixture.calls).toEqual(['refresh']);
});

it('does not sign after an owner change during an in-flight reservation', async () => {
  const fixture = setup();
  const reserve = fixture.ports.reservations.reserve;
  fixture.ports.reservations.reserve = async (...args) => { const saved = await reserve(...args); fixture.switchScope(); return saved; };
  const client = createPaymentClient(fixture.ports);
  await expect(client.authorizePay(fixture.prepared, fixture.prepared.record.contentHash)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
  expect(fixture.calls).not.toContain('sign-pool');
});

it('keeps an unknown submission attached to the reserved operation', async () => {
  const fixture = setup();
  fixture.ports.submit = async () => ({ kind: 'unknown' });
  const client = createPaymentClient(fixture.ports);
  const result = await client.authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  expect(result.chainOutcome).toBe('unknown');
  expect((await fixture.reservations.get(scope, record.recordId))?.record.attemptIds).toEqual(['attempt-1']);
});

it('continues with the original record after a lost reservation ACK is recovered by lookup', async () => {
  const fixture = setup();
  fixture.reservations.control.loseNextAck();
  const result = await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  expect(result.chainOutcome).toBe('pending');
  expect(fixture.calls.slice(0, 5)).toEqual(['encrypt:1', 'reserve', 'get', 'encrypt:2', 'update']);
  expect(fixture.calls.filter((call) => call === 'reserve')).toHaveLength(1);
});

it('keeps the wallet closed if a lost ACK cannot be verified by lookup', async () => {
  const fixture = setup();
  fixture.reservations.control.loseNextAck();
  fixture.ports.reservations.get = async () => { throw new Error('lookup unavailable'); };
  await expect(createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(fixture.calls).not.toContain('sign-pool');
});

it('does not sign when the quote becomes stale while waiting for the signature-start ACK', async () => {
  const fixture = setup();
  const update = fixture.ports.reservations.update;
  fixture.ports.reservations.update = async (...args) => {
    const saved = await update(...args);
    fixture.setNow(30_001);
    return saved;
  };
  await expect(createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash))
    .rejects.toMatchObject({ code: 'QUOTE_STALE' });
  expect(fixture.calls).not.toContain('sign-pool');
});

it('does not request a payment signature when the quote expires during pool signing', async () => {
  const fixture = setup();
  fixture.ports.signPool = async () => { fixture.calls.push('sign-pool'); fixture.setNow(30_001); return '0x11'; };
  await expect(createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash))
    .rejects.toMatchObject({ code: 'QUOTE_STALE' });
  expect(fixture.calls).not.toContain('sign-payment');
});

it('rejects a full Withdraw that races with a Pay for the same input', async () => {
  const fixture = setup();
  const withdraw = parseOperationRecord({
    kind: 'withdraw', recordId: `0x${'77'.repeat(32)}`, inputId,
    operationId: `0x${'88'.repeat(32)}`, contentHash: blockHash,
    encryptedBundle: record.encryptedBundle, signatureStarted: false, attemptIds: [],
  }, scope);
  if (withdraw.kind !== 'withdraw') throw new Error('invalid fixture');
  fixture.ports.prepareFullWithdraw = async () => ({
    record: withdraw, privateBytes: new Uint8Array([4]), poolAuthorization: { operationId: withdraw.operationId },
  });
  const client = createPaymentClient(fixture.ports);
  await client.authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  await expect(client.authorizeFullWithdraw(await client.prepareFullWithdraw(undefined), withdraw.contentHash))
    .rejects.toMatchObject({ code: 'CONFLICT' });
  expect(fixture.calls.filter((call) => call === 'sign-pool')).toHaveLength(1);
});

it('allows only the recovery action supported by a fresh finalized view', async () => {
  const fixture = setup();
  await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  const actions: string[] = [];
  const failedEvidence: RecoveryEvidence = {
    finalized: true, blockTime: 599n, paymentSucceeded: false,
    submissionKnownAbsent: false,
    attempts: [{ id: 'attempt-1', outcome: 'finalized-failure' }],
    storageAvailability: 'healthy',
  };
  fixture.ports.recovery = {
    readEvidence: async () => ({ evidence: failedEvidence, currentInput: { state: 'unspent' } }),
    restoreOriginal: async () => { actions.push('resume'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    restoreForRetry: async () => { actions.push('retry'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    releaseAndPrepareChangedTerms: async () => { actions.push('change'); return fixture.prepared; },
  };
  const client = createPaymentClient(fixture.ports);
  await expect(client.resumeOriginal(recordId as never)).rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
  expect(actions).toEqual([]);
  expect((await client.retryAttempt(recordId as never)).kind).toBe('submitted');
  expect(actions).toEqual(['retry']);
  expect((await fixture.reservations.get(scope, record.recordId))?.record.attemptIds).toEqual(['attempt-1', 'attempt-2']);
  expect(fixture.sealedHashes).toEqual([blockHash, blockHash]);
});

it('does not execute recovery when reservation state rolls back or an attempt is unresolved', async () => {
  const fixture = setup();
  await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  const actions: string[] = [];
  fixture.ports.recovery = {
    readEvidence: async () => ({
      evidence: {
        finalized: true, blockTime: 601n, paymentSucceeded: false,
        submissionKnownAbsent: false,
        attempts: [{ id: 'attempt-1', outcome: 'unknown' }],
        storageAvailability: 'healthy',
      },
      currentInput: { state: 'unspent' },
    }),
    restoreOriginal: async () => { actions.push('resume'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    restoreForRetry: async () => { actions.push('retry'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    releaseAndPrepareChangedTerms: async () => { actions.push('change'); return fixture.prepared; },
  };
  const client = createPaymentClient(fixture.ports);
  await expect(client.prepareChangedTerms(recordId as never, 'new terms')).rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
  fixture.reservations.control.simulateRollback();
  await expect(client.retryAttempt(recordId as never)).rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
  expect(actions).toEqual([]);
});

it('blocks recovery after a detected storage rollback even when chain evidence permits retry', async () => {
  const fixture = setup();
  await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  fixture.reservations.control.simulateRollback();
  const actions: string[] = [];
  fixture.ports.recovery = {
    readEvidence: async () => ({
      evidence: {
        finalized: true, blockTime: 599n, paymentSucceeded: false,
        submissionKnownAbsent: false,
        attempts: [{ id: 'attempt-1', outcome: 'finalized-failure' }],
        storageAvailability: 'healthy',
      },
      currentInput: { state: 'unspent' },
    }),
    restoreOriginal: async () => { actions.push('resume'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    restoreForRetry: async () => { actions.push('retry'); return { prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }; },
    releaseAndPrepareChangedTerms: async () => { actions.push('change'); return fixture.prepared; },
  };
  await expect(createPaymentClient(fixture.ports).retryAttempt(recordId as never))
    .rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
  expect(actions).toEqual([]);
});

it('persists exactly one retry attempt before submitting when two callers race', async () => {
  const fixture = setup();
  await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  fixture.ports.recovery = {
    readEvidence: async () => ({
      evidence: {
        finalized: true, blockTime: 599n, paymentSucceeded: false,
        submissionKnownAbsent: false,
        attempts: [{ id: 'attempt-1', outcome: 'finalized-failure' }],
        storageAvailability: 'healthy',
      },
      currentInput: { state: 'unspent' },
    }),
    restoreOriginal: async () => ({ prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }),
    restoreForRetry: async () => ({ prepared: fixture.prepared, signatures: { pool: '0x11', payment: '0x22' } }),
    releaseAndPrepareChangedTerms: async () => fixture.prepared,
  };
  let recoverySubmits = 0;
  fixture.ports.submit = async () => { recoverySubmits += 1; return { kind: 'submitted', txHash: blockHash as never }; };
  const client = createPaymentClient(fixture.ports);
  const results = await Promise.allSettled([
    client.retryAttempt(recordId as never), client.retryAttempt(recordId as never),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(recoverySubmits).toBe(1);
  expect((await fixture.reservations.get(scope, record.recordId))?.record.attemptIds).toHaveLength(2);
});

it('reconciles only against the current scope and a healthy saved operation', async () => {
  const fixture = setup();
  const ref = await createPaymentClient(fixture.ports).authorizePay(fixture.prepared, fixture.prepared.record.contentHash);
  const changeOutputId = `0x${'99'.repeat(32)}` as never;
  fixture.ports.reconciliation = {
    expectedChainId: 31337n,
    readFinalized: async () => ({
      history: {
        chainId: 31337n, deploymentId: scope.deploymentId, blockHash: blockHash as never,
        finalized: true, canonical: true, rpcConsistent: true,
        adapter: { blockHash, paymentId: record.paymentId, operationId: record.operationId, owner: scope.owner, amountOut: 99n },
        pool: { blockHash, operationId: record.operationId, inputId: record.inputId, changeOutputId },
        input: { blockHash, inputId: record.inputId, consumed: true },
        change: { blockHash, outputId: changeOutputId, owner: scope.owner },
      } as never,
      receipt: { state: 'confirmed', outputId: changeOutputId, currentlyUnspent: true },
    }),
  };
  const client = createPaymentClient(fixture.ports);
  expect((await client.reconcile(recordId as never, ref)).operation.chainOutcome).toBe('finalized-success');
  fixture.reservations.control.simulateRollback();
  await expect(client.reconcile(recordId as never, ref)).rejects.toMatchObject({ code: 'RECOVERY_BLOCKED' });
});
