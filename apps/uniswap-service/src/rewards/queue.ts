import type { ServiceContext } from '../extensions.js';
import { createProductionRewardRunner } from './production.js';
import { classifyRewardFailure, rewardAvailability, setRewardAvailability } from './availability.js';

export type RewardQueueRunner = {
  probe?(): Promise<boolean>;
  dispatch(requestId: string): Promise<void>;
  reconcile(requestId: string): Promise<void>;
  verifyFinalized(requestId: string, checkpointHash: string): Promise<boolean | undefined>;
};

type QueueRow = { request_id: string; status: string; checkpoint_hash: string | null };

/** Runs at most one distribution step, always in acceptance order. */
export async function runRewardAlarm(context: ServiceContext, injected?: RewardQueueRunner): Promise<void> {
  context.ensureWritable();
  if (context.deploymentId === undefined) throw new Error('UNKNOWN_DEPLOYMENT');
  const deploymentId = context.deploymentId;
  if (injected === undefined) {
    const any = context.storage.sql.exec<{ seq: number }>(
      `SELECT seq FROM reward_requests WHERE deployment_id = ? AND status <> 'ended-without-distribution'
       LIMIT 1`, deploymentId,
    ).toArray()[0];
    if (any === undefined) return;
  }
  const initialAvailability = rewardAvailability(context.storage, context.recoveryGate, deploymentId);
  if (!initialAvailability.distribute && initialAvailability.reason !== 'rpc-unavailable') return;
  let runner: RewardQueueRunner;
  try { runner = injected ?? await createProductionRewardRunner(context); }
  catch (error) {
    const reason = classifyRewardFailure(error);
    setRewardAvailability(context.storage, deploymentId, reason);
    if (reason === 'rpc-unavailable') await context.scheduleAlarm(Date.now() + 30_000);
    return;
  }
  const finalized = context.storage.sql.exec<QueueRow>(
    `SELECT request_id, status, checkpoint_hash FROM reward_requests
     WHERE deployment_id = ? AND status IN ('finalized', 'received') ORDER BY seq`, deploymentId,
  ).toArray();
  for (const row of finalized) {
    if (row.checkpoint_hash === null) continue;
    let valid: boolean | undefined;
    try { valid = await runner.verifyFinalized(row.request_id, row.checkpoint_hash); }
    catch { valid = undefined; }
    if (valid === undefined) {
      setRewardAvailability(context.storage, deploymentId, 'rpc-unavailable');
      await context.scheduleAlarm(Date.now() + 30_000);
      return;
    }
    if (!valid) {
      context.storage.transactionSync(() => {
        const seq = context.storage.sql.exec<{ seq: number }>(
          'SELECT seq FROM reward_requests WHERE deployment_id = ? AND request_id = ?', deploymentId, row.request_id,
        ).toArray()[0]?.seq;
        if (seq === undefined) throw new Error('REWARD_REORG_CONFLICT');
        context.storage.sql.exec(`UPDATE reward_requests SET status = 'unknown', state_version = state_version + 1
          WHERE deployment_id = ? AND seq >= ? AND status <> 'ended-without-distribution'`,
        deploymentId, seq);
        context.storage.sql.exec(`UPDATE reward_inputs SET status = 'unknown'
          WHERE deployment_id = ? AND request_id IN
          (SELECT request_id FROM reward_requests WHERE deployment_id = ? AND seq >= ?)`,
        deploymentId, deploymentId, seq);
        context.storage.sql.exec(`UPDATE reward_reservations SET released = 0
          WHERE deployment_id = ? AND request_id IN
          (SELECT request_id FROM reward_requests WHERE deployment_id = ? AND seq >= ?)`,
        deploymentId, deploymentId, seq);
        context.storage.sql.exec(`INSERT INTO reward_availability (deployment_id, reason, checked_at_ms)
          VALUES (?, 'restore-stopped', ?) ON CONFLICT(deployment_id) DO UPDATE SET
          reason = 'restore-stopped', checked_at_ms = excluded.checked_at_ms`, deploymentId, Date.now());
      });
      return;
    }
  }
  const availability = rewardAvailability(context.storage, context.recoveryGate, deploymentId);
  if (!availability.distribute && availability.reason !== 'rpc-unavailable') return;
  const next = context.storage.sql.exec<QueueRow>(
    `SELECT request_id, status, checkpoint_hash FROM reward_requests
     WHERE deployment_id = ? AND status IN ('accepted', 'queued', 'processing', 'pending', 'unknown')
     ORDER BY seq LIMIT 1`, deploymentId,
  ).toArray()[0];
  if (next === undefined) {
    if (availability.reason === 'rpc-unavailable' && await runner.probe?.() === true) {
      setRewardAvailability(context.storage, deploymentId, 'healthy');
    } else if (availability.reason === 'rpc-unavailable') {
      await context.scheduleAlarm(Date.now() + 30_000);
    }
    return;
  }
  try {
    if (next.status === 'pending' || next.status === 'unknown' || next.status === 'processing') {
      await runner.reconcile(next.request_id);
    } else {
      await runner.dispatch(next.request_id);
    }
    if (availability.reason === 'rpc-unavailable' && await runner.probe?.() === true) {
      setRewardAvailability(context.storage, deploymentId, 'healthy');
    }
  } catch (error) {
    const reason = classifyRewardFailure(error);
    setRewardAvailability(context.storage, deploymentId, reason);
    if (reason !== 'rpc-unavailable') return;
  }
  await context.scheduleAlarm(Date.now() + 30_000);
}
