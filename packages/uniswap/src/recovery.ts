import type { SavedReservation } from './reservation.js';

export interface AttemptEvidence {
  readonly id: string;
  readonly outcome: 'finalized-failure' | 'finalized-success' | 'pending' | 'unknown';
}

export interface RecoveryEvidence {
  readonly finalized: boolean;
  readonly blockTime: bigint;
  readonly paymentSucceeded: boolean;
  readonly submissionKnownAbsent: boolean;
  readonly attempts: readonly AttemptEvidence[];
  readonly storageAvailability: 'healthy' | 'rollback' | 'unavailable';
}

export interface CurrentInput {
  readonly state: 'unspent' | 'spent' | 'unknown';
}

export interface RecoveryDecision {
  readonly action: 'recheck' | 'resume-original' | 'retry-attempt' | 'change-terms' | 'complete' | 'blocked';
  readonly reason?: 'RESULT_UNKNOWN' | 'SERVICE_UNAVAILABLE' | 'INPUT_USED' | 'AUTHORIZATION_ACTIVE' | 'INPUT_RESERVED';
}

export function inspectOperation(
  saved: SavedReservation,
  evidence: RecoveryEvidence,
  currentInput: CurrentInput,
): RecoveryDecision {
  if (evidence.storageAvailability !== 'healthy') {
    return { action: 'recheck', reason: 'SERVICE_UNAVAILABLE' };
  }
  if (!evidence.finalized || currentInput.state === 'unknown') {
    return { action: 'recheck', reason: 'RESULT_UNKNOWN' };
  }
  if (evidence.paymentSucceeded) return { action: 'complete' };
  if (saved.reservationState !== 'active') {
    return { action: 'blocked', reason: 'INPUT_RESERVED' };
  }
  if (currentInput.state === 'spent') {
    return { action: 'blocked', reason: 'INPUT_USED' };
  }
  const recordedIds = new Set<string>(saved.record.attemptIds);
  if (evidence.attempts.length !== recordedIds.size
    || evidence.attempts.some((attempt) => !recordedIds.has(attempt.id)
      || attempt.outcome !== 'finalized-failure')) {
    return { action: 'recheck', reason: 'RESULT_UNKNOWN' };
  }
  if (saved.record.kind === 'pay' && evidence.blockTime > saved.record.deadline) {
    return { action: 'change-terms' };
  }
  if (recordedIds.size > 0) return { action: 'retry-attempt' };
  if (!evidence.submissionKnownAbsent) {
    return { action: 'recheck', reason: 'RESULT_UNKNOWN' };
  }
  return { action: 'resume-original' };
}
