import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeServiceContext } from '../src/extensions.js';
import { runRewardAlarm } from '../src/rewards/queue.js';
import { initializeEnvironment } from '../src/recovery.js';
import { resumeRewardAvailability, setRewardAvailability } from '../src/rewards/availability.js';

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
    state.storage.sql.exec(`UPDATE reward_requests SET status = 'finalized', checkpoint_hash = ?
      WHERE request_id = ?`, `0x${'cc'.repeat(32)}`, ids[0]);
    setRewardAvailability(state.storage, 'local-v1', 'operator-stopped');
    await runRewardAlarm(context, { ...runner, verifyFinalized: async () => undefined });
    expect(state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
      .toBe('operator-stopped');
    resumeRewardAvailability(state.storage, { generation: 'test-g1', stopped: false },
      'local-v1', true, {});
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
      'SELECT status FROM reward_requests WHERE request_id = ?', b).toArray()[0]?.status).toBe('accepted');
    expect(state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
      .toBe('restore-stopped');
    await runRewardAlarm({ ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' }, {
      dispatch: async () => {}, reconcile: async () => {}, verifyFinalized: async () => undefined,
    });
    expect(state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
      .toBe('restore-stopped');
  });
});

it('clears only a transient RPC stop before reconciling a saved attempt', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-queue-rpc-resume'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const id = `0x${'dd'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
      amount_wei, recipient_info_json, content_hash, status, operation_id)
      VALUES ('local-v1', ?, ?, '1', '{}', ?, 'pending', ?)`, `0x${'11'.repeat(20)}`, id, id, id);
    setRewardAvailability(state.storage, 'local-v1', 'rpc-unavailable');
    let reconciled = false;
    await runRewardAlarm({ ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' }, {
      probe: async () => true,
      dispatch: async () => {},
      reconcile: async () => {
        expect(state.storage.sql.exec<{ reason: string }>(
          "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
          .toBe('healthy');
        reconciled = true;
      },
      verifyFinalized: async () => true,
    });
    expect(reconciled).toBe(true);
  });
});

it('stops and restores obligations when a finalized cancellation is reorged', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-queue-cancel-reorg'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const id = `0x${'dc'.repeat(32)}`;
    const next = `0x${'ef'.repeat(32)}`;
    const old = `0x${'ab'.repeat(32)}`;
    const cancel = `0x${'cd'.repeat(32)}`;
    const checkpoint = `0x${'aa'.repeat(32)}`;
    for (const [subject, requestId, status, operationId] of [
      [`0x${'11'.repeat(20)}`, id, 'ended-without-distribution', old],
      [`0x${'22'.repeat(20)}`, next, 'accepted', null],
    ] as const) state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
      amount_wei, recipient_info_json, content_hash, status, operation_id)
      VALUES ('local-v1', ?, ?, '1', '{}', ?, ?, ?)`, subject, requestId, requestId, status, operationId);
    state.storage.sql.exec(`INSERT INTO reward_reservations
      (deployment_id, request_id, amount_wei, released) VALUES ('local-v1', ?, '1', 1)`, id);
    state.storage.sql.exec(`INSERT INTO reward_cancellations
      (deployment_id, request_id, phase, operation_id, input_id, encrypted_draft, checkpoint_hash)
      VALUES ('local-v1', ?, 'raw-saved', ?, ?, 'encrypted', ?)`, id, cancel,
      `0x${'aa'.repeat(32)}`, checkpoint);
    let dispatched = false;
    await runRewardAlarm({ ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' }, {
      dispatch: async () => { dispatched = true; }, reconcile: async () => {},
      verifyFinalized: async () => true,
      verifyCancellationFinalized: async () => false,
    });
    expect(dispatched).toBe(false);
    expect(state.storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE request_id = ?', id).toArray()[0]?.status).toBe('unknown');
    expect(state.storage.sql.exec<{ released: number }>(
      'SELECT released FROM reward_reservations WHERE request_id = ?', id).toArray()[0]?.released).toBe(0);
    expect(state.storage.sql.exec<{ reason: string }>(
      "SELECT reason FROM reward_availability WHERE deployment_id = 'local-v1'").toArray()[0]?.reason)
      .toBe('restore-stopped');
  });
});

it('withdraws a queued reward when its finalized consolidation is reorged', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-queue-consolidation-reorg'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const id = `0x${'a1'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
      amount_wei, recipient_info_json, content_hash, status)
      VALUES ('local-v1', ?, ?, '10', '{}', 'hash', 'accepted')`, `0x${'11'.repeat(20)}`, id);
    state.storage.sql.exec(`INSERT INTO reward_consolidations (deployment_id, request_id,
      round, phase, operation_id, input_ids_json, checkpoint_hash)
      VALUES ('local-v1', ?, 1, 'finalized', ?, ?, ?)`, id,
    `0x${'bb'.repeat(32)}`, JSON.stringify([`0x${'cc'.repeat(32)}`, `0x${'dd'.repeat(32)}`]),
    `0x${'ee'.repeat(32)}`);
    let dispatched = false;
    await runRewardAlarm({ ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }),
      deploymentId: 'local-v1' }, {
      dispatch: async () => { dispatched = true; }, reconcile: async () => {},
      verifyFinalized: async () => true, verifyConsolidationFinalized: async () => false,
    });
    expect(dispatched).toBe(false);
    expect(state.storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE request_id = ?', id).toArray()[0]?.status).toBe('unknown');
  });
});
