import type { RewardAvailability } from '@confidential-utxo/uniswap';
import type { RecoveryGate } from '../recovery.js';
import { getAvailability } from '../recovery.js';
import { CoreFailure } from '@confidential-utxo/core';
import { EthereumFailure } from '@confidential-utxo/ethereum';

export type RewardAvailabilityState = {
  readonly accept: boolean;
  readonly distribute: boolean;
  readonly receive: boolean;
  readonly reason: RewardAvailability;
};

export function setRewardAvailability(storage: DurableObjectStorage, deploymentId: string,
  reason: RewardAvailability): void {
  storage.transactionSync(() => {
    if (['operator-stopped', 'quota-stopped', 'restore-stopped'].includes(reason)) {
      storage.sql.exec(`INSERT OR IGNORE INTO reward_stop_flags (deployment_id, reason) VALUES (?, ?)`,
        deploymentId, reason);
    } else if (reason === 'healthy') {
      storage.sql.exec(`DELETE FROM reward_transient_stop
        WHERE deployment_id = ? AND reason = 'rpc-unavailable'`, deploymentId);
    } else {
      storage.sql.exec('INSERT OR IGNORE INTO reward_transient_stop (deployment_id, reason) VALUES (?, ?)',
        deploymentId, reason);
    }
    refreshReason(storage, deploymentId);
  });
}

function refreshReason(storage: DurableObjectStorage, deploymentId: string): RewardAvailability {
  const flags = storage.sql.exec<{ reason: RewardAvailability }>(
    'SELECT reason FROM reward_stop_flags WHERE deployment_id = ?', deploymentId,
  ).toArray().map((row) => row.reason);
  const transient = storage.sql.exec<{ reason: RewardAvailability }>(
    'SELECT reason FROM reward_transient_stop WHERE deployment_id = ?', deploymentId,
  ).toArray().map((row) => row.reason);
  const reason = (['restore-stopped', 'quota-stopped', 'operator-stopped'] as const)
    .find((item) => flags.includes(item))
    ?? (['rpc-unavailable', 'funds-short', 'gas-short'] as const).find((item) => transient.includes(item))
    ?? 'healthy';
  storage.sql.exec(`INSERT INTO reward_availability (deployment_id, reason, checked_at_ms)
    VALUES (?, ?, ?) ON CONFLICT(deployment_id) DO UPDATE SET
    reason = excluded.reason, checked_at_ms = excluded.checked_at_ms`, deploymentId, reason, Date.now());
  return reason;
}

export function classifyRewardFailure(error: unknown): RewardAvailability {
  if (error instanceof CoreFailure) {
    if (error.code === 'INSUFFICIENT') return 'funds-short';
    if (error.code === 'RPC' || error.code === 'HISTORY_UNAVAILABLE' || error.code === 'UNCONFIRMED') {
      return 'rpc-unavailable';
    }
  }
  if (error instanceof EthereumFailure) {
    if (error.code === 'SIMULATION_FAILED' && error.stage === 'submission.balance') return 'gas-short';
    if (['RPC', 'GAP', 'HASH_MISMATCH', 'TIMEOUT', 'SUBMISSION_UNKNOWN'].includes(error.code)) {
      return 'rpc-unavailable';
    }
  }
  if (error instanceof Error && error.message === 'REWARD_FUNDS_UNKNOWN') return 'rpc-unavailable';
  return 'operator-stopped';
}

/** The external recovery gate always wins over a reward-only healthy state. */
export function rewardAvailability(storage: DurableObjectStorage, gate: RecoveryGate,
  deploymentId: string): RewardAvailabilityState {
  if (getAvailability(storage, gate) !== 'healthy') {
    return { accept: false, distribute: false, receive: false, reason: 'restore-stopped' };
  }
  const row = storage.sql.exec<{ reason: string }>(
    'SELECT reason FROM reward_availability WHERE deployment_id = ?', deploymentId,
  ).toArray()[0];
  const known: readonly RewardAvailability[] = [
    'healthy', 'rpc-unavailable', 'funds-short', 'gas-short',
    'operator-stopped', 'quota-stopped', 'restore-stopped',
  ];
  const reason = known.includes(row?.reason as RewardAvailability)
    ? row!.reason as RewardAvailability : row === undefined ? 'healthy' : 'restore-stopped';
  if (reason === 'healthy') return { accept: true, distribute: true, receive: true, reason };
  if (reason === 'funds-short' || reason === 'gas-short') {
    return { accept: false, distribute: false, receive: true, reason };
  }
  return { accept: false, distribute: false, receive: false, reason };
}

export type RewardResumeEvidence = {
  readonly fundsReady?: boolean;
  readonly gasReady?: boolean;
  readonly recordsComplete?: boolean;
  readonly chainReconciled?: boolean;
  readonly keysReadable?: boolean;
  readonly attemptsChecked?: boolean;
};

export function resumeRewardAvailability(storage: DurableObjectStorage, gate: RecoveryGate,
  deploymentId: string, operatorAuthorized: boolean, evidence: RewardResumeEvidence): void {
  if (!operatorAuthorized) throw new Error('OPERATOR_UNAUTHORIZED');
  if (getAvailability(storage, gate) !== 'healthy') throw new Error('SERVICE_UNAVAILABLE');
  const reason = rewardAvailability(storage, gate, deploymentId).reason;
  if ((reason === 'funds-short' && evidence.fundsReady !== true)
    || (reason === 'gas-short' && evidence.gasReady !== true)
    || (reason === 'restore-stopped' && (evidence.recordsComplete !== true
      || evidence.chainReconciled !== true || evidence.keysReadable !== true
      || evidence.attemptsChecked !== true))) {
    throw new Error('REWARD_RESUME_EVIDENCE');
  }
  if (['restore-stopped', 'quota-stopped', 'operator-stopped'].includes(reason)) {
    storage.sql.exec('DELETE FROM reward_stop_flags WHERE deployment_id = ? AND reason = ?',
      deploymentId, reason);
    refreshReason(storage, deploymentId);
  } else if (reason === 'funds-short' || reason === 'gas-short') {
    storage.sql.exec('DELETE FROM reward_transient_stop WHERE deployment_id = ? AND reason = ?',
      deploymentId, reason);
    refreshReason(storage, deploymentId);
  } else {
    setRewardAvailability(storage, deploymentId, 'healthy');
  }
}
