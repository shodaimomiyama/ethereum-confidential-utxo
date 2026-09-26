import type { AttemptId, Bytes32, OperationRef, Scope, TxHash } from './domain.js';
import type { EncryptedBundle, OperationRecord } from './storage.js';
import type { ReservationPort, SavedReservation } from './reservation.js';
import type { MonotonicClock, PayQuote } from './quote.js';
import { isQuoteFresh } from './quote.js';
import { inspectOperation } from './recovery.js';
import type { CurrentInput, RecoveryEvidence } from './recovery.js';
import { reconcilePayment } from './reconcile.js';
import type { CoreReceiptResult, FinalizedHistory, ReconciledPayment } from './reconcile.js';

export class PaymentProcessError extends Error {
  constructor(readonly code: 'TERMS_CHANGED' | 'SCOPE_CHANGED' | 'QUOTE_STALE' | 'TERMS_EXPIRED' | 'INPUT_RESERVED' | 'INPUT_INVALID' | 'RECOVERY_BLOCKED' | 'RECOVERY_UNAVAILABLE') {
    super(code);
    this.name = 'PaymentProcessError';
  }
}

interface PreparedBase {
  readonly record: OperationRecord;
  readonly privateBytes: Uint8Array;
  readonly poolAuthorization: Readonly<Record<string, unknown>>;
}

export interface PreparedPay extends PreparedBase {
  readonly quote: PayQuote;
}

export interface PreparedFullWithdraw extends PreparedBase {
  readonly record: Extract<OperationRecord, { readonly kind: 'withdraw' }>;
}

export interface AuthorizationSignatures {
  readonly pool: `0x${string}`;
  readonly payment?: `0x${string}`;
}

export type SubmissionOutcome =
  | { readonly kind: 'submitted'; readonly txHash: TxHash }
  | { readonly kind: 'not-submitted' }
  | { readonly kind: 'unknown' };

export interface RecoveryPorts {
  readEvidence(saved: SavedReservation): Promise<{ readonly evidence: RecoveryEvidence; readonly currentInput: CurrentInput }>;
  restoreOriginal(saved: SavedReservation, evidence: RecoveryEvidence): Promise<{ readonly prepared: PreparedPay | PreparedFullWithdraw; readonly signatures?: AuthorizationSignatures }>;
  restoreForRetry(saved: SavedReservation, evidence: RecoveryEvidence): Promise<{ readonly prepared: PreparedBase; readonly signatures: AuthorizationSignatures }>;
  releaseAndPrepareChangedTerms(saved: SavedReservation, evidence: RecoveryEvidence, input: unknown): Promise<PreparedPay>;
}

export interface ReconciliationPorts {
  readonly expectedChainId: bigint;
  readFinalized(ref: OperationRef, saved: SavedReservation): Promise<{
    readonly history: FinalizedHistory;
    readonly receipt: CoreReceiptResult;
  }>;
}

export interface PaymentPorts {
  reservations: ReservationPort;
  recovery?: RecoveryPorts;
  reconciliation?: ReconciliationPorts;
  preparePay(input: unknown): Promise<PreparedPay>;
  prepareFullWithdraw(input: unknown): Promise<PreparedFullWithdraw>;
  refreshPay(prepared: PreparedPay): Promise<PreparedPay>;
  validatePrepared(prepared: PreparedBase): Promise<void>;
  currentScope(): Scope;
  clock: MonotonicClock;
  latestBlockTime(): Promise<bigint>;
  encrypt(plaintext: Uint8Array, context: { readonly scope: Scope; readonly recordId: Bytes32; readonly revision: number }): Promise<EncryptedBundle>;
  sealContent(prepared: PreparedBase, signatures: AuthorizationSignatures, attemptId?: AttemptId, txHash?: TxHash): Uint8Array;
  signPool(payload: Readonly<Record<string, unknown>>): Promise<`0x${string}`>;
  signPayment(prepared: PreparedPay): Promise<`0x${string}`>;
  createAttempt(prepared: PreparedBase, signatures: AuthorizationSignatures): AttemptId;
  submit(prepared: PreparedBase, signatures: AuthorizationSignatures, attemptId: AttemptId): Promise<SubmissionOutcome>;
}

export interface PaymentClient {
  preparePay(input: unknown): Promise<PreparedPay>;
  prepareFullWithdraw(input: unknown): Promise<PreparedFullWithdraw>;
  authorizePay(prepared: PreparedPay, confirmedContentHash: Bytes32): Promise<OperationRef>;
  authorizeFullWithdraw(prepared: PreparedFullWithdraw, confirmedContentHash: Bytes32): Promise<OperationRef>;
  resumeOriginal(recordId: Bytes32): Promise<SubmissionOutcome>;
  retryAttempt(recordId: Bytes32): Promise<SubmissionOutcome>;
  prepareChangedTerms(recordId: Bytes32, input: unknown): Promise<PreparedPay>;
  reconcile(recordId: Bytes32, ref: OperationRef): Promise<ReconciledPayment>;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.deploymentId === b.deploymentId && a.owner.toLowerCase() === b.owner.toLowerCase();
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function createPaymentClient(ports: PaymentPorts): PaymentClient {
  function assertScope(scope: Scope): void {
    if (!sameScope(ports.currentScope(), scope)) throw new PaymentProcessError('SCOPE_CHANGED');
  }

  function assertSaved(saved: SavedReservation, expected: OperationRecord, revision: number): void {
    if (saved.reservationState !== 'active' || saved.revision !== revision
      || !sameScope(saved.record.scope, expected.scope)
      || !sameHash(saved.record.recordId, expected.recordId)
      || saved.record.kind !== expected.kind
      || !sameHash(saved.record.inputId, expected.inputId)
      || !sameHash(saved.record.operationId, expected.operationId)
      || !sameHash(saved.record.contentHash, expected.contentHash)
      || (saved.record.kind === 'pay' && expected.kind === 'pay'
        && (!sameHash(saved.record.paymentId, expected.paymentId)
          || saved.record.deadline !== expected.deadline))
      || saved.record.signatureStarted !== expected.signatureStarted
      || saved.record.attemptIds.join('\u0000') !== expected.attemptIds.join('\u0000')) {
      throw new PaymentProcessError('INPUT_RESERVED');
    }
    if (saved.record.encryptedBundle.ciphertext !== expected.encryptedBundle.ciphertext
      || saved.record.encryptedBundle.nonce !== expected.encryptedBundle.nonce
      || saved.record.encryptedBundle.tag !== expected.encryptedBundle.tag) {
      throw new PaymentProcessError('INPUT_RESERVED');
    }
  }

  async function encryptRecord(record: OperationRecord, data: Uint8Array, revision: number): Promise<OperationRecord> {
    const encryptedBundle = await ports.encrypt(data, { scope: record.scope, recordId: record.recordId, revision });
    assertScope(record.scope);
    return { ...record, encryptedBundle };
  }

  async function recoverAck(expected: OperationRecord, revision: number, action: () => Promise<SavedReservation>): Promise<SavedReservation> {
    try {
      return await action();
    } catch (cause) {
      let found: SavedReservation | undefined;
      try {
        found = await ports.reservations.get(expected.scope, expected.recordId);
      } catch {
        throw cause;
      }
      if (found?.reservationState === 'active'
        && found.revision === revision
        && sameHash(found.record.contentHash, expected.contentHash)
        && found.record.signatureStarted === expected.signatureStarted
        && found.record.attemptIds.join('\u0000') === expected.attemptIds.join('\u0000')
        && found.record.encryptedBundle.ciphertext === expected.encryptedBundle.ciphertext
        && found.record.encryptedBundle.nonce === expected.encryptedBundle.nonce
        && found.record.encryptedBundle.tag === expected.encryptedBundle.tag) {
        return found;
      }
      throw cause;
    }
  }

  async function assertPayTermsLive(prepared: PreparedPay): Promise<void> {
    if (!isQuoteFresh(prepared.quote, ports.clock.now())) {
      throw new PaymentProcessError('QUOTE_STALE');
    }
    if (prepared.record.kind !== 'pay' || await ports.latestBlockTime() >= prepared.record.deadline) {
      throw new PaymentProcessError('TERMS_EXPIRED');
    }
    assertScope(prepared.record.scope);
  }

  async function persistKnownHash(
    saved: SavedReservation,
    prepared: PreparedBase,
    signatures: AuthorizationSignatures,
    attemptId: AttemptId,
    txHash: TxHash,
  ): Promise<void> {
    const revision = saved.revision + 1;
    const bytes = ports.sealContent(prepared, signatures, attemptId, txHash);
    const record = await encryptRecord(saved.record, bytes, revision);
    const updated = await recoverAck(record, revision,
      () => ports.reservations.update(record, saved.revision, revision));
    assertScope(saved.record.scope);
    assertSaved(updated, record, revision);
  }

  async function authorize(preparedInput: PreparedBase, confirmedContentHash: Bytes32, isPay: boolean): Promise<OperationRef> {
    let prepared = preparedInput;
    const initialScope = prepared.record.scope;
    assertScope(initialScope);
    if (!sameHash(confirmedContentHash, prepared.record.contentHash)
      || prepared.record.signatureStarted || prepared.record.attemptIds.length !== 0
      || (isPay && prepared.record.kind !== 'pay')
      || (!isPay && prepared.record.kind !== 'withdraw')) {
      throw new PaymentProcessError('INPUT_INVALID');
    }

    if (isPay) {
      const pay = prepared as PreparedPay;
      if (!isQuoteFresh(pay.quote, ports.clock.now())) {
        prepared = await ports.refreshPay(pay);
        assertScope(initialScope);
        if (!sameHash(prepared.record.contentHash, confirmedContentHash)) {
          throw new PaymentProcessError('TERMS_CHANGED');
        }
        if (!isQuoteFresh((prepared as PreparedPay).quote, ports.clock.now())) {
          throw new PaymentProcessError('QUOTE_STALE');
        }
      }
      await assertPayTermsLive(prepared as PreparedPay);
    }
    await ports.validatePrepared(prepared);
    assertScope(initialScope);

    const reservedRecord = await encryptRecord(prepared.record, prepared.privateBytes, 1);
    const reserved = await recoverAck(reservedRecord, 1,
      () => ports.reservations.reserve(reservedRecord, 0, 1));
    assertScope(initialScope);
    assertSaved(reserved, reservedRecord, 1);

    const startedRecord = await encryptRecord({ ...reserved.record, signatureStarted: true }, prepared.privateBytes, 2);
    const started = await recoverAck(startedRecord, 2,
      () => ports.reservations.update(startedRecord, 1, 2));
    assertScope(initialScope);
    assertSaved(started, startedRecord, 2);
    if (isPay) {
      await assertPayTermsLive(prepared as PreparedPay);
    }
    const pool = await ports.signPool(prepared.poolAuthorization);
    assertScope(initialScope);
    if (isPay) await assertPayTermsLive(prepared as PreparedPay);
    const payment = isPay ? await ports.signPayment(prepared as PreparedPay) : undefined;
    assertScope(initialScope);
    const signatures: AuthorizationSignatures = { pool, ...(payment === undefined ? {} : { payment }) };

    const signedBytes = ports.sealContent(prepared, signatures);
    const signedRecord = await encryptRecord(started.record, signedBytes, 3);
    const signed = await recoverAck(signedRecord, 3,
      () => ports.reservations.update(signedRecord, 2, 3));
    assertScope(initialScope);
    assertSaved(signed, signedRecord, 3);

    const attemptId = ports.createAttempt(prepared, signatures);
    const attemptBytes = ports.sealContent(prepared, signatures, attemptId);
    const attemptedRecord = await encryptRecord({ ...signed.record, attemptIds: [...signed.record.attemptIds, attemptId] }, attemptBytes, 4);
    const attempted = await recoverAck(attemptedRecord, 4, () => ports.reservations.update(attemptedRecord, 3, 4));
    assertScope(initialScope);
    assertSaved(attempted, attemptedRecord, 4);

    let outcome: Awaited<ReturnType<PaymentPorts['submit']>>;
    try {
      outcome = await ports.submit(prepared, signatures, attemptId);
    } catch {
      outcome = { kind: 'unknown' };
    }
    assertScope(initialScope);
    if (outcome.kind === 'submitted') {
      await persistKnownHash(attempted, prepared, signatures, attemptId, outcome.txHash);
    }
    return {
      scope: initialScope,
      operationId: prepared.record.operationId,
      ...(prepared.record.kind === 'pay' ? { paymentId: prepared.record.paymentId } : {}),
      attemptIds: [attemptId],
      txHashes: outcome.kind === 'submitted' ? [outcome.txHash] : [],
      chainOutcome: outcome.kind === 'submitted' ? 'pending'
        : outcome.kind === 'not-submitted' ? 'not-submitted' : 'unknown',
      receiptState: 'none',
    };
  }

  async function recover<T>(
    recordId: Bytes32,
    action: 'resume-original' | 'retry-attempt' | 'change-terms',
    execute: (recovery: RecoveryPorts, saved: SavedReservation, evidence: RecoveryEvidence) => Promise<T>,
  ): Promise<T> {
    const recovery = ports.recovery;
    if (recovery === undefined) throw new PaymentProcessError('RECOVERY_UNAVAILABLE');
    const scope = ports.currentScope();
    const listed = await ports.reservations.list(scope);
    assertScope(scope);
    if (listed.availability !== 'healthy') throw new PaymentProcessError('RECOVERY_BLOCKED');
    const saved = listed.records.find(({ record }) => sameHash(record.recordId, recordId));
    if (saved === undefined || !sameScope(saved.record.scope, scope)) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    const { evidence, currentInput } = await recovery.readEvidence(saved);
    assertScope(scope);
    const latest = await ports.reservations.get(scope, recordId);
    assertScope(scope);
    if (latest === undefined || latest.revision !== saved.revision
      || latest.reservationState !== saved.reservationState
      || !sameHash(latest.record.contentHash, saved.record.contentHash)
      || latest.record.attemptIds.join('\u0000') !== saved.record.attemptIds.join('\u0000')) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    if (inspectOperation(saved, evidence, currentInput).action !== action) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    if (action === 'retry-attempt' && !saved.record.signatureStarted) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    const result = await execute(recovery, saved, evidence);
    assertScope(scope);
    return result;
  }

  async function submitRecovered(
    saved: SavedReservation,
    restored: { readonly prepared: PreparedBase; readonly signatures: AuthorizationSignatures },
  ): Promise<SubmissionOutcome> {
    const { prepared, signatures } = restored;
    assertRecoveredPrepared(saved, prepared);
    if (prepared.record.kind === 'pay' && signatures.payment === undefined) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    await ports.validatePrepared(prepared);
    assertScope(saved.record.scope);
    const attemptId = ports.createAttempt(prepared, signatures);
    if (saved.record.attemptIds.includes(attemptId)) throw new PaymentProcessError('RECOVERY_BLOCKED');
    const nextRevision = saved.revision + 1;
    const attemptBytes = ports.sealContent(prepared, signatures, attemptId);
    const attemptedRecord = await encryptRecord({
      ...saved.record, attemptIds: [...saved.record.attemptIds, attemptId],
    }, attemptBytes, nextRevision);
    const attempted = await recoverAck(attemptedRecord, nextRevision,
      () => ports.reservations.update(attemptedRecord, saved.revision, nextRevision));
    assertScope(saved.record.scope);
    assertSaved(attempted, attemptedRecord, nextRevision);
    let outcome: SubmissionOutcome;
    try {
      outcome = await ports.submit(prepared, signatures, attemptId);
    } catch {
      return { kind: 'unknown' };
    }
    if (outcome.kind === 'submitted') {
      await persistKnownHash(attempted, prepared, signatures, attemptId, outcome.txHash);
    }
    return outcome;
  }

  function assertRecoveredPrepared(saved: SavedReservation, prepared: PreparedBase): void {
    assertScope(saved.record.scope);
    if (!sameScope(prepared.record.scope, saved.record.scope)
      || !sameHash(prepared.record.recordId, saved.record.recordId)
      || !sameHash(prepared.record.inputId, saved.record.inputId)
      || !sameHash(prepared.record.contentHash, saved.record.contentHash)
      || !sameHash(prepared.record.operationId, saved.record.operationId)
      || prepared.record.kind !== saved.record.kind
      || (prepared.record.kind === 'pay' && saved.record.kind === 'pay'
        && (!sameHash(prepared.record.paymentId, saved.record.paymentId)
          || prepared.record.deadline !== saved.record.deadline))) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
  }

  async function resumeOriginal(
    saved: SavedReservation,
    restored: { readonly prepared: PreparedPay | PreparedFullWithdraw; readonly signatures?: AuthorizationSignatures },
  ): Promise<SubmissionOutcome> {
    const { prepared } = restored;
    assertRecoveredPrepared(saved, prepared);
    if (!saved.record.signatureStarted && restored.signatures !== undefined) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    let current = saved;
    if (!current.record.signatureStarted) {
      const revision = current.revision + 1;
      const record = await encryptRecord({ ...current.record, signatureStarted: true }, prepared.privateBytes, revision);
      current = await recoverAck(record, revision,
        () => ports.reservations.update(record, saved.revision, revision));
      assertScope(saved.record.scope);
      assertSaved(current, record, revision);
    }
    let signatures = restored.signatures;
    if (signatures === undefined) {
      if (prepared.record.kind === 'pay') await assertPayTermsLive(prepared as PreparedPay);
      const pool = await ports.signPool(prepared.poolAuthorization);
      assertScope(saved.record.scope);
      if (prepared.record.kind === 'pay') await assertPayTermsLive(prepared as PreparedPay);
      const payment = prepared.record.kind === 'pay'
        ? await ports.signPayment(prepared as PreparedPay) : undefined;
      assertScope(saved.record.scope);
      signatures = { pool, ...(payment === undefined ? {} : { payment }) };
      const revision = current.revision + 1;
      const bytes = ports.sealContent(prepared, signatures);
      const record = await encryptRecord(current.record, bytes, revision);
      const previousRevision = current.revision;
      current = await recoverAck(record, revision,
        () => ports.reservations.update(record, previousRevision, revision));
      assertScope(saved.record.scope);
      assertSaved(current, record, revision);
    }
    return submitRecovered(current, { prepared, signatures });
  }

  async function reconcile(recordId: Bytes32, ref: OperationRef): Promise<ReconciledPayment> {
    const adapter = ports.reconciliation;
    if (adapter === undefined) throw new PaymentProcessError('RECOVERY_UNAVAILABLE');
    const scope = ports.currentScope();
    if (!sameScope(scope, ref.scope)) throw new PaymentProcessError('SCOPE_CHANGED');
    const listed = await ports.reservations.list(scope);
    assertScope(scope);
    if (listed.availability !== 'healthy') throw new PaymentProcessError('RECOVERY_BLOCKED');
    const saved = listed.records.find(({ record }) => sameHash(record.recordId, recordId));
    if (saved === undefined || !sameScope(saved.record.scope, scope)
      || !sameHash(saved.record.operationId, ref.operationId)
      || saved.record.kind !== 'pay' || !sameHash(saved.record.paymentId, ref.paymentId ?? '')) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    const { history, receipt } = await adapter.readFinalized(ref, saved);
    assertScope(scope);
    const latest = await ports.reservations.get(scope, recordId);
    assertScope(scope);
    if (latest === undefined || latest.revision !== saved.revision
      || !sameHash(latest.record.contentHash, saved.record.contentHash)) {
      throw new PaymentProcessError('RECOVERY_BLOCKED');
    }
    return reconcilePayment(ref, saved.record, history, receipt, adapter.expectedChainId);
  }

  return {
    preparePay: (input) => ports.preparePay(input),
    prepareFullWithdraw: (input) => ports.prepareFullWithdraw(input),
    authorizePay: (prepared, confirmation) => authorize(prepared, confirmation, true),
    authorizeFullWithdraw: (prepared, confirmation) => authorize(prepared, confirmation, false),
    resumeOriginal: (recordId) => recover(recordId, 'resume-original',
      async (recovery, saved, evidence) => resumeOriginal(saved, await recovery.restoreOriginal(saved, evidence))),
    retryAttempt: (recordId) => recover(recordId, 'retry-attempt',
      async (recovery, saved, evidence) => submitRecovered(saved, await recovery.restoreForRetry(saved, evidence))),
    prepareChangedTerms: (recordId, input) => recover(recordId, 'change-terms',
      (recovery, saved, evidence) => recovery.releaseAndPrepareChangedTerms(saved, evidence, input)),
    reconcile,
  };
}
