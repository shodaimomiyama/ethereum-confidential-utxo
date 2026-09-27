import type { ServiceContext } from '../extensions.js';
import { createProductionRewardRunner } from './production.js';
import { classifyRewardFailure, rewardAvailability, setRewardAvailability } from './availability.js';

export type RewardQueueRunner = {
  probe?(): Promise<boolean>;
  dispatch(requestId: string): Promise<void>;
  reconcile(requestId: string): Promise<void>;
  verifyFinalized(requestId: string, checkpointHash: string): Promise<boolean | undefined>;
  verifyCancellationFinalized?(requestId: string, checkpointHash: string): Promise<boolean | undefined>;
  verifyConsolidationFinalized?(requestId: string, operationId: string,
    inputIds: string[], checkpointHash: string): Promise<boolean | undefined>;
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
  if (initialAvailability.reason === 'rpc-unavailable') {
    try {
      if (await runner.probe?.() !== true) {
        await context.scheduleAlarm(Date.now() + 30_000);
        return;
      }
      setRewardAvailability(context.storage, deploymentId, 'healthy');
    } catch {
      await context.scheduleAlarm(Date.now() + 30_000);
      return;
    }
  }
  const cancelled = context.storage.sql.exec<QueueRow>(
    `SELECT r.request_id, r.status, c.checkpoint_hash FROM reward_requests r
     JOIN reward_cancellations c ON c.deployment_id = r.deployment_id AND c.request_id = r.request_id
     WHERE r.deployment_id = ? AND r.status = 'ended-without-distribution'
     ORDER BY r.seq`, deploymentId,
  ).toArray();
  for (const row of cancelled) {
    let valid: boolean | undefined;
    try { valid = row.checkpoint_hash === null ? undefined
      : await runner.verifyCancellationFinalized?.(row.request_id, row.checkpoint_hash); }
    catch { valid = undefined; }
    if (valid === undefined) {
      setRewardAvailability(context.storage, deploymentId, 'rpc-unavailable');
      await context.scheduleAlarm(Date.now() + 30_000);
      return;
    }
    if (!valid) {
      invalidateAfterReorg(context.storage, deploymentId, row.request_id, true);
      return;
    }
  }
  const consolidated = context.storage.sql.exec<{ request_id: string; operation_id: string;
    input_ids_json: string; checkpoint_hash: string }>(
    `SELECT request_id, operation_id, input_ids_json, checkpoint_hash FROM reward_consolidations
     WHERE deployment_id = ? AND phase = 'finalized' ORDER BY rowid`, deploymentId,
  ).toArray();
  for (const row of consolidated) {
    let valid: boolean | undefined;
    try { valid = await runner.verifyConsolidationFinalized?.(row.request_id, row.operation_id,
      JSON.parse(row.input_ids_json) as string[], row.checkpoint_hash); }
    catch { valid = undefined; }
    if (valid === undefined) {
      setRewardAvailability(context.storage, deploymentId, 'rpc-unavailable');
      await context.scheduleAlarm(Date.now() + 30_000);
      return;
    }
    if (!valid) {
      invalidateAfterReorg(context.storage, deploymentId, row.request_id, true);
      return;
    }
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
      invalidateAfterReorg(context.storage, deploymentId, row.request_id, false);
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

function invalidateAfterReorg(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, cancelled: boolean): void {
  storage.transactionSync(() => {
    const seq = storage.sql.exec<{ seq: number }>(
      'SELECT seq FROM reward_requests WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
    ).toArray()[0]?.seq;
    if (seq === undefined) throw new Error('REWARD_REORG_CONFLICT');
    storage.sql.exec(`UPDATE reward_requests SET status = 'unknown', state_version = state_version + 1
      WHERE deployment_id = ? AND seq >= ? AND
      (status IN ('finalized', 'received', 'processing', 'pending', 'unknown')
        OR (? = 1 AND request_id = ? AND status IN ('ended-without-distribution', 'accepted', 'queued')))`,
    deploymentId, seq, cancelled ? 1 : 0, requestId);
    storage.sql.exec(`UPDATE reward_inputs SET status = 'unknown'
      WHERE deployment_id = ? AND request_id IN
      (SELECT request_id FROM reward_requests WHERE deployment_id = ? AND seq >= ?
       AND status = 'unknown')`, deploymentId, deploymentId, seq);
    storage.sql.exec(`UPDATE reward_reservations SET released = 0
      WHERE deployment_id = ? AND request_id IN
      (SELECT request_id FROM reward_requests WHERE deployment_id = ? AND seq >= ?
       AND status <> 'ended-without-distribution')`, deploymentId, deploymentId, seq);
  });
  setRewardAvailability(storage, deploymentId, 'restore-stopped');
}
