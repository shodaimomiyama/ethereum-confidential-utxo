import type { Bytes32, Scope } from './domain.js';
import type { OperationRecord, SavedOperation } from './storage.js';

export interface SavedReservation extends SavedOperation {
  readonly reservationState: 'active' | 'released';
}

export interface ReleaseEvidence {
  readonly blockHash: Bytes32;
}

export interface VerifiedReleaseState {
  readonly finalized: boolean;
  readonly blockTime: bigint;
  readonly paymentSucceeded: boolean;
  readonly inputUnspent: boolean;
  readonly inputConsumed: boolean;
}

export interface ReservationPort {
  reserve(record: OperationRecord, expectedRevision: number, sealedRevision: number): Promise<SavedReservation>;
  update(record: OperationRecord, expectedRevision: number, sealedRevision: number): Promise<SavedReservation>;
  get(scope: Scope, recordId: Bytes32): Promise<SavedReservation | undefined>;
  list(scope: Scope): Promise<{ readonly availability: 'healthy' | 'rollback'; readonly records: readonly SavedReservation[] }>;
  release(record: OperationRecord, evidence: ReleaseEvidence, expectedRevision: number, sealedRevision: number): Promise<SavedReservation>;
}
