import type {
  Bytes32, OperationRecord, OperationResponse, ReservationPort, SavedReservation,
  Scope, StoredOperation, WireOperationRecord,
} from '@confidential-utxo/uniswap';
import { HttpFailure, sameScope, type HttpClient } from './http.js';

export interface LiveSavedReservation extends SavedReservation, StoredOperation {}
export interface LiveReservationPort extends ReservationPort {
  reserve(record: OperationRecord, expectedRevision: number, sealedRevision: number): Promise<LiveSavedReservation>;
  update(record: OperationRecord, expectedRevision: number, sealedRevision: number): Promise<LiveSavedReservation>;
  get(scope: Scope, recordId: Bytes32): Promise<LiveSavedReservation | undefined>;
  list(scope: Scope): Promise<{ readonly availability: 'healthy' | 'rollback'; readonly records: readonly LiveSavedReservation[] }>;
  release(...args: Parameters<ReservationPort['release']>): Promise<LiveSavedReservation>;
}

function wire(record: OperationRecord): WireOperationRecord {
  const base = { recordId: record.recordId, inputId: record.inputId, operationId: record.operationId,
    contentHash: record.contentHash, encryptedBundle: record.encryptedBundle,
    signatureStarted: record.signatureStarted, attemptIds: record.attemptIds };
  return record.kind === 'pay'
    ? { ...base, kind: 'pay', paymentId: record.paymentId, deadline: record.deadline.toString(10) }
    : { ...base, kind: 'withdraw' };
}
function sameRecord(a: OperationRecord, b: OperationRecord): boolean {
  return sameScope(a.scope, b.scope) && a.kind === b.kind
    && a.recordId.toLowerCase() === b.recordId.toLowerCase()
    && a.inputId.toLowerCase() === b.inputId.toLowerCase()
    && a.operationId.toLowerCase() === b.operationId.toLowerCase()
    && a.contentHash.toLowerCase() === b.contentHash.toLowerCase()
    && a.signatureStarted === b.signatureStarted
    && a.attemptIds.length === b.attemptIds.length
    && a.attemptIds.every((id, index) => id === b.attemptIds[index])
    && a.encryptedBundle.ciphertext === b.encryptedBundle.ciphertext
    && a.encryptedBundle.nonce === b.encryptedBundle.nonce
    && a.encryptedBundle.tag === b.encryptedBundle.tag
    && (a.kind !== 'pay' || (b.kind === 'pay' && a.paymentId.toLowerCase() === b.paymentId.toLowerCase() && a.deadline === b.deadline));
}
function revision(expected: number, sealed: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(sealed)
    || sealed !== expected + 1) throw new Error('INVALID_RESERVATION_REVISION');
}
function checked(saved: OperationResponse, scope: Scope, id?: Bytes32, fromRead = false): LiveSavedReservation {
  if (!sameScope(saved.scope, scope) || !sameScope(saved.record.scope, scope)
    || (id !== undefined && saved.record.recordId.toLowerCase() !== id.toLowerCase())
    || !Number.isSafeInteger(saved.revision) || saved.revision < 1
    || saved.stateVersion === undefined || !Number.isSafeInteger(saved.stateVersion) || saved.stateVersion < 1
    || (saved.status !== 'reserved' && saved.status !== 'released')) throw new Error('RESERVATION_STATE_UNCONFIRMED');
  // #55 cannot faithfully represent unknown/consumed/finalized-success. Recovery
  // exposes those rich states separately; they must not become actionable here.
  const reservationState = saved.status === 'reserved' ? 'active' : 'released';
  if (fromRead && saved.status === 'reserved' && saved.reservationState !== 'active') {
    throw new Error('RESERVATION_STATE_UNCONFIRMED');
  }
  if (saved.reservationState !== undefined && saved.reservationState !== reservationState) throw new Error('RESERVATION_STATE_UNCONFIRMED');
  return { ...saved, reservationState };
}
function ack(saved: SavedReservation, record: OperationRecord, sealed: number, state: SavedReservation['reservationState']): void {
  if (saved.revision !== sealed || saved.reservationState !== state || !sameRecord(saved.record, record)) {
    throw new Error('RESERVATION_ACK_UNCONFIRMED');
  }
}

/** Transport adaptation only. #55 owns authorization ordering and lost-ACK recovery. */
export function createReservationPort(http: HttpClient): LiveReservationPort {
  async function put(record: OperationRecord, expectedRevision: number, sealedRevision: number): Promise<LiveSavedReservation> {
    revision(expectedRevision, sealedRevision);
    const expected = structuredClone(record);
    const saved = checked(await http.call('PUT /v1/operations/{id}', { scope: expected.scope, id: expected.recordId,
      body: { scope: expected.scope, expectedRevision, sealedRevision, record: wire(expected) } }), expected.scope, expected.recordId);
    ack(saved, expected, sealedRevision, 'active');
    return saved;
  }
  async function get(scope: Scope, recordId: Bytes32): Promise<LiveSavedReservation | undefined> {
    const expectedScope = { ...scope };
    try { return checked(await http.call('GET /v1/operations/{id}', { scope: expectedScope, id: recordId }), expectedScope, recordId, true); }
    catch (error) {
      if (error instanceof HttpFailure && error.kind === 'api' && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }
  return {
    reserve: put,
    update: put,
    get,
    async list(scope) {
      const expectedScope = { ...scope };
      const records: LiveSavedReservation[] = [];
      const seen = new Set<string>();
      let cursor: Bytes32 | undefined;
      for (;;) {
        const page = await http.call('GET /v1/operations', { scope: expectedScope, cursor });
        if (page.availability === 'rollback') return { availability: 'rollback', records: [] };
        if (page.availability !== 'healthy' || (cursor !== undefined && page.records.length === 0)) throw new Error('RESERVATION_LIST_UNCONFIRMED');
        let lastId = '';
        for (const raw of page.records) {
          const saved = checked(raw, expectedScope, undefined, true);
          const id = saved.record.recordId.toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(id) || seen.has(id) || (cursor !== undefined && id <= cursor)) throw new Error('RESERVATION_LIST_UNCONFIRMED');
          seen.add(id);
          if (id > lastId) lastId = id;
          records.push(saved);
        }
        if (page.nextCursor === undefined) return { availability: 'healthy', records };
        const next = page.nextCursor.toLowerCase() as Bytes32;
        if (next !== lastId || (cursor !== undefined && next <= cursor)) throw new Error('RESERVATION_LIST_UNCONFIRMED');
        cursor = next;
      }
    },
    async release(record, evidence, expectedRevision, sealedRevision) {
      revision(expectedRevision, sealedRevision);
      const expected = structuredClone(record);
      const released = await http.call('POST /v1/operations/{id}/release', { scope: expected.scope, id: expected.recordId,
        body: { scope: expected.scope, expectedRevision, sealedRevision, blockHash: evidence.blockHash, record: wire(expected) } });
      if (!sameScope(released.scope, expected.scope)) throw new Error('RESERVATION_ACK_UNCONFIRMED');
      ack(released, expected, sealedRevision, 'released');
      // The shared release response is legacy-shaped. Require independent rich
      // confirmation; #57 currently returns 503 until release is implemented.
      const confirmed = await get(expected.scope, expected.recordId);
      if (!confirmed) throw new Error('RESERVATION_ACK_UNCONFIRMED');
      ack(confirmed, expected, sealedRevision, 'released');
      return confirmed;
    },
  };
}
