import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { advanceSignedCancellation, endUndistributedReward } from '../src/rewards/operator.js';
import { keccak256 } from 'viem';

it('ends only a provably unsigned request and releases its reservation', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-operator-end'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'aa'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status) VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'processing')`,
    `0x${'11'.repeat(20)}`, id);
    state.storage.sql.exec(`INSERT INTO reward_reservations (deployment_id, request_id, amount_wei)
      VALUES ('local-v1', ?, '2')`, id);
    state.storage.sql.exec(`INSERT INTO reward_drafts (deployment_id, request_id, phase, version)
      VALUES ('local-v1', ?, 'draft-saved', 1)`, id);
    await expect(endUndistributedReward(state.storage, 'local-v1', id, { authorized: false }))
      .rejects.toThrow('OPERATOR_UNAUTHORIZED');
    expect((await endUndistributedReward(state.storage, 'local-v1', id, { authorized: true })).status)
      .toBe('ended-without-distribution');
    expect(state.storage.sql.exec<{ released: number }>(
      'SELECT released FROM reward_reservations WHERE request_id = ?', id).toArray())
      .toEqual([{ released: 1 }]);
  });
});

it('persists cancellation draft and raw before broadcast, then ends only after finality evidence', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-operator-cancel'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'cc'.repeat(32)}`;
    const old = `0x${'dd'.repeat(32)}`;
    const cancel = `0x${'ee'.repeat(32)}`;
    const input = `0x${'ff'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status, operation_id)
      VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'pending', ?)`, `0x${'11'.repeat(20)}`, id, old);
    state.storage.sql.exec(`INSERT INTO reward_reservations (deployment_id, request_id, amount_wei)
      VALUES ('local-v1', ?, '2')`, id);
    state.storage.sql.exec(`INSERT INTO reward_drafts (deployment_id, request_id, phase, version)
      VALUES ('local-v1', ?, 'signature-started', 1)`, id);
    const raw = '0x1234' as `0x${string}`;
    let finalized = false;
    const sent: string[] = [];
    const ports = {
      build: async () => ({ operationId: cancel, inputId: input, draft: { operationId: cancel } }),
      sign: async (draft: { operationId: string }) => ({ ...draft, signature: '0xsigned' }),
      prepare: async () => ({ raw, hash: keccak256(raw), nonce: 7 }),
      broadcast: async (stored: string) => { sent.push(stored); },
      observe: async () => finalized ? 'cancel-finalized' as const : 'none' as const,
    };
    const key = new Uint8Array(32).fill(9);
    expect((await advanceSignedCancellation(state.storage, 'local-v1', id,
      { authorized: true }, key, ports)).status).toBe('pending');
    expect(sent).toEqual([raw]);
    expect(state.storage.sql.exec<{ encrypted_raw: string }>(
      'SELECT encrypted_raw FROM reward_cancellations WHERE request_id = ?', id).toArray()[0]?.encrypted_raw)
      .not.toBe(raw);
    finalized = true;
    expect((await advanceSignedCancellation(state.storage, 'local-v1', id,
      { authorized: true }, key, ports)).status).toBe('ended-without-distribution');
  });
});

it('refuses unsigned termination after the signer boundary', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-operator-signed'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'bb'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status) VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'processing')`,
    `0x${'11'.repeat(20)}`, id);
    state.storage.sql.exec(`INSERT INTO reward_drafts (deployment_id, request_id, phase, version)
      VALUES ('local-v1', ?, 'signature-started', 1)`, id);
    await expect(endUndistributedReward(state.storage, 'local-v1', id, { authorized: true }))
      .rejects.toThrow('CANCELLATION_REQUIRED');
    expect(state.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reward_cancellations'").toArray())
      .toEqual([{ name: 'reward_cancellations' }]);
  });
});
