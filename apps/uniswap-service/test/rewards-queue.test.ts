import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeServiceContext } from '../src/extensions.js';
import { runRewardAlarm } from '../src/rewards/queue.js';
import { initializeEnvironment } from '../src/recovery.js';

it('dispatches by sequence after finalized without waiting for received', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-queue-sequence'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const ids = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`];
    for (const [index, id] of ids.entries()) {
      state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
        amount_wei, recipient_info_json, content_hash, status)
        VALUES ('local-v1', ?, ?, '1', '{}', ?, 'accepted')`, `0x${String(index + 1).padStart(2, '0').repeat(20)}`, id, id);
    }
    const sent: string[] = [];
    const context = { ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' };
    const runner = {
      dispatch: async (id: string) => { sent.push(id); state.storage.sql.exec(
        `UPDATE reward_requests SET status = 'pending' WHERE request_id = ?`, id); },
      reconcile: async () => {},
      verifyFinalized: async () => true,
    };
    await runRewardAlarm(context, runner);
    await runRewardAlarm(context, runner);
    expect(sent).toEqual([ids[0]]);
    state.storage.sql.exec(`UPDATE reward_requests SET status = 'finalized' WHERE request_id = ?`, ids[0]);
    await runRewardAlarm(context, runner);
    expect(sent).toEqual(ids);
  });
});

it('stops later distribution when a finalized ancestor is reorged', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-queue-reorg'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const a = `0x${'aa'.repeat(32)}`;
    const b = `0x${'bb'.repeat(32)}`;
    for (const [index, [id, status]] of ([[a, 'finalized'], [b, 'accepted']] as const).entries()) {
      state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
        amount_wei, recipient_info_json, content_hash, status, checkpoint_hash)
        VALUES ('local-v1', ?, ?, '1', '{}', ?, ?, ?)`, `0x${String(index + 1).padStart(2, '0').repeat(20)}`, id, id, status,
      `0x${'cc'.repeat(32)}`);
    }
    const sent: string[] = [];
    await runRewardAlarm({ ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' }, {
      dispatch: async (id: string) => { sent.push(id); }, reconcile: async () => {},
      verifyFinalized: async () => false,
    });
    expect(sent).toEqual([]);
    expect(state.storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE request_id = ?', a).toArray()[0]?.status).toBe('unknown');
    expect(state.storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE request_id = ?', b).toArray()[0]?.status).toBe('unknown');
    expect(state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
      .toBe('restore-stopped');
  });
});
