import type { Bytes32, Scope } from '../domain.js';
import type { OperationRecord } from '../storage.js';
import { StoreError } from '../storage.js';
import type { ReleaseEvidence, ReservationPort, SavedReservation, VerifiedReleaseState } from '../reservation.js';

export interface MemoryReservationControl {
  loseNextAck(): void;
  simulateRollback(): void;
  setUnavailable(value: boolean): void;
}

export interface MemoryReservationPort extends ReservationPort {
  readonly control: MemoryReservationControl;
}

export interface ReleaseVerifier {
  verify(record: OperationRecord, evidence: ReleaseEvidence): Promise<VerifiedReleaseState>;
}

function scopeKey(scope: Scope): string {
  return `${scope.deploymentId}\u0000${scope.owner.toLowerCase()}`;
}

function recordKey(scope: Scope, recordId: Bytes32): string {
  return `${scopeKey(scope)}\u0000${recordId.toLowerCase()}`;
}

function inputKey(record: OperationRecord): string {
  return `${scopeKey(record.scope)}\u0000${record.inputId.toLowerCase()}`;
}

function sameFixedContent(a: OperationRecord, b: OperationRecord): boolean {
  return a.kind === b.kind
    && a.recordId.toLowerCase() === b.recordId.toLowerCase()
    && a.inputId.toLowerCase() === b.inputId.toLowerCase()
    && a.operationId.toLowerCase() === b.operationId.toLowerCase()
    && a.contentHash.toLowerCase() === b.contentHash.toLowerCase()
    && a.scope.owner.toLowerCase() === b.scope.owner.toLowerCase()
    && a.scope.deploymentId === b.scope.deploymentId
    && (a.kind !== 'pay' || (b.kind === 'pay'
      && a.paymentId.toLowerCase() === b.paymentId.toLowerCase()
      && a.deadline === b.deadline));
}

function sameRecord(a: OperationRecord, b: OperationRecord): boolean {
  return sameFixedContent(a, b)
    && a.signatureStarted === b.signatureStarted
    && a.attemptIds.join('\u0000') === b.attemptIds.join('\u0000')
    && a.encryptedBundle.ciphertext === b.encryptedBundle.ciphertext
    && a.encryptedBundle.nonce === b.encryptedBundle.nonce
    && a.encryptedBundle.tag === b.encryptedBundle.tag;
}

function preservesHistory(previous: OperationRecord, next: OperationRecord): boolean {
  return !(previous.signatureStarted && !next.signatureStarted)
    && previous.attemptIds.every((id, index) => next.attemptIds[index] === id);
}

export function createMemoryReservationPort(verifier: ReleaseVerifier = {
  verify: async () => ({ finalized: false, blockTime: 0n, paymentSucceeded: false, inputUnspent: false, inputConsumed: false }),
}): MemoryReservationPort {
  const records = new Map<string, SavedReservation>();
  const activeInputs = new Map<string, string>();
  const usedNonces = new Map<string, Set<string>>();
  let rolledBack = false;
  let loseAck = false;
  let unavailable = false;

  function writable(): void {
    if (rolledBack || unavailable) throw new StoreError('UNAVAILABLE');
  }

  function readable(): void {
    if (unavailable) throw new StoreError('UNAVAILABLE');
  }

  function checkRevision(expected: number, sealed: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0
      || !Number.isSafeInteger(sealed) || sealed !== expected + 1) {
      throw new StoreError('REVISION_CONFLICT');
    }
  }

  function saved(record: OperationRecord, revision: number, reservationState: SavedReservation['reservationState']): SavedReservation {
    return structuredClone({ record, revision, reservationState });
  }

  function put(record: OperationRecord, expectedRevision: number, sealedRevision: number, creating: boolean): SavedReservation {
    writable();
    const key = recordKey(record.scope, record.recordId);
    const current = records.get(key);
    if (current !== undefined && sameRecord(current.record, record)) return structuredClone(current);
    checkRevision(expectedRevision, sealedRevision);
    if (creating) {
      if (current !== undefined) throw new StoreError('CONFLICT');
      if (expectedRevision !== 0) throw new StoreError('REVISION_CONFLICT');
      if (activeInputs.has(inputKey(record))) throw new StoreError('CONFLICT');
      const created = saved(record, sealedRevision, 'active');
      records.set(key, created);
      activeInputs.set(inputKey(record), key);
      usedNonces.set(key, new Set([record.encryptedBundle.nonce]));
      if (loseAck) {
        loseAck = false;
        throw new StoreError('UNAVAILABLE');
      }
      return structuredClone(created);
    }
    if (current === undefined) throw new StoreError('NOT_FOUND');
    if (current.reservationState !== 'active' || !sameFixedContent(current.record, record)) throw new StoreError('CONFLICT');
    if (current.revision !== expectedRevision) throw new StoreError('REVISION_CONFLICT');
    if (!preservesHistory(current.record, record)) throw new StoreError('CONFLICT');
    if (usedNonces.get(key)?.has(record.encryptedBundle.nonce)) throw new StoreError('CONFLICT');
    const updated = saved(record, sealedRevision, 'active');
    records.set(key, updated);
    usedNonces.get(key)?.add(record.encryptedBundle.nonce);
    return structuredClone(updated);
  }

  return {
    reserve: async (record, expectedRevision, sealedRevision) => put(record, expectedRevision, sealedRevision, true),
    update: async (record, expectedRevision, sealedRevision) => put(record, expectedRevision, sealedRevision, false),
    get: async (scope, recordId) => {
      readable();
      const current = records.get(recordKey(scope, recordId));
      return current === undefined ? undefined : structuredClone(current);
    },
    list: async (scope) => {
      readable();
      return {
        availability: rolledBack ? 'rollback' : 'healthy',
        records: [...records.values()]
          .filter(({ record }) => scopeKey(record.scope) === scopeKey(scope))
          .map((record) => structuredClone(record)),
      };
    },
    release: async (record, evidence, expectedRevision, sealedRevision) => {
      writable();
      checkRevision(expectedRevision, sealedRevision);
      const key = recordKey(record.scope, record.recordId);
      const current = records.get(key);
      if (current === undefined) throw new StoreError('NOT_FOUND');
      if (current.reservationState !== 'active' || !sameFixedContent(current.record, record)) throw new StoreError('CONFLICT');
      if (current.revision !== expectedRevision) throw new StoreError('REVISION_CONFLICT');
      if (!preservesHistory(current.record, record)) throw new StoreError('CONFLICT');
      if (usedNonces.get(key)?.has(record.encryptedBundle.nonce)) throw new StoreError('CONFLICT');
      const result = await verifier.verify(current.record, evidence);
      if (!result.finalized) throw new StoreError('NOT_FINALIZED');
      if (current.record.kind === 'pay') {
        if (result.blockTime <= current.record.deadline || result.paymentSucceeded || !result.inputUnspent) {
          throw new StoreError('NOT_FINALIZED');
        }
      } else if (!result.inputConsumed) {
        throw new StoreError('NOT_FINALIZED');
      }
      writable();
      if (records.get(key)?.revision !== expectedRevision) throw new StoreError('REVISION_CONFLICT');
      const released = saved(record, sealedRevision, 'released');
      records.set(key, released);
      usedNonces.get(key)?.add(record.encryptedBundle.nonce);
      activeInputs.delete(inputKey(record));
      return structuredClone(released);
    },
    control: {
      loseNextAck: () => { loseAck = true; },
      simulateRollback: () => { rolledBack = true; },
      setUnavailable: (value) => { unavailable = value; },
    },
  };
}
