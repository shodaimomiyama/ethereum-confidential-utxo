import type { AttemptId, Bytes32, OperationRef, Scope, TxHash } from './domain.js';
import type { EncryptedBundle, OperationRecord } from './storage.js';
import type { ReservationPort, SavedReservation } from './reservation.js';
import type { MonotonicClock, PayQuote } from './quote.js';
import { isQuoteFresh } from './quote.js';

export class PaymentProcessError extends Error {
  constructor(readonly code: 'TERMS_CHANGED' | 'SCOPE_CHANGED' | 'QUOTE_STALE' | 'TERMS_EXPIRED' | 'INPUT_RESERVED' | 'INPUT_INVALID') {
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

export interface PaymentPorts {
  reservations: ReservationPort;
  preparePay(input: unknown): Promise<PreparedPay>;
  prepareFullWithdraw(input: unknown): Promise<PreparedFullWithdraw>;
  refreshPay(prepared: PreparedPay): Promise<PreparedPay>;
  validatePrepared(prepared: PreparedBase): Promise<void>;
  currentScope(): Scope;
  clock: MonotonicClock;
  latestBlockTime(): Promise<bigint>;
  encrypt(plaintext: Uint8Array, context: { readonly scope: Scope; readonly recordId: Bytes32; readonly revision: number }): Promise<EncryptedBundle>;
  sealContent(prepared: PreparedBase, signatures: AuthorizationSignatures, attemptId?: AttemptId): Uint8Array;
  signPool(payload: Readonly<Record<string, unknown>>): Promise<`0x${string}`>;
  signPayment(prepared: PreparedPay): Promise<`0x${string}`>;
  createAttempt(prepared: PreparedBase, signatures: AuthorizationSignatures): AttemptId;
  submit(prepared: PreparedBase, signatures: AuthorizationSignatures, attemptId: AttemptId): Promise<
    | { readonly kind: 'submitted'; readonly txHash: TxHash }
    | { readonly kind: 'not-submitted' }
    | { readonly kind: 'unknown' }
  >;
}

export interface PaymentClient {
  preparePay(input: unknown): Promise<PreparedPay>;
  prepareFullWithdraw(input: unknown): Promise<PreparedFullWithdraw>;
  authorizePay(prepared: PreparedPay, confirmedContentHash: Bytes32): Promise<OperationRef>;
  authorizeFullWithdraw(prepared: PreparedFullWithdraw, confirmedContentHash: Bytes32): Promise<OperationRef>;
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
        && found.record.attemptIds.join('\u0000') === expected.attemptIds.join('\u0000')) {
        return found;
      }
      throw cause;
    }
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
      const latestBlockTime = await ports.latestBlockTime();
      assertScope(initialScope);
      if (prepared.record.kind !== 'pay' || latestBlockTime >= prepared.record.deadline) {
        throw new PaymentProcessError('TERMS_EXPIRED');
      }
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
      if (!isQuoteFresh((prepared as PreparedPay).quote, ports.clock.now())) {
        throw new PaymentProcessError('QUOTE_STALE');
      }
      if (prepared.record.kind !== 'pay' || await ports.latestBlockTime() >= prepared.record.deadline) {
        throw new PaymentProcessError('TERMS_EXPIRED');
      }
      assertScope(initialScope);
    }
    const pool = await ports.signPool(prepared.poolAuthorization);
    assertScope(initialScope);
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

  return {
    preparePay: (input) => ports.preparePay(input),
    prepareFullWithdraw: (input) => ports.prepareFullWithdraw(input),
    authorizePay: (prepared, confirmation) => authorize(prepared, confirmation, true),
    authorizeFullWithdraw: (prepared, confirmation) => authorize(prepared, confirmation, false),
  };
}
