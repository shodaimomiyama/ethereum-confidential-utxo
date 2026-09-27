import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyMigrations } from '../src/schema.js';
import { rewardMigrations } from '../src/rewards/schema.js';

it('persists one active request per owner and allows another after received', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('rewards-schema-test'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    applyMigrations(state.storage, rewardMigrations);
    applyMigrations(state.storage, rewardMigrations);
    const sql = state.storage.sql;
    const insert = (requestId: string) => sql.exec(
      `INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei, recipient_info_json,
       content_hash, status) VALUES (?, ?, ?, '1', '{}', ?, 'accepted')`,
      'local-v1', '0xowner', requestId, requestId,
    );
    insert('first');
    expect(() => insert('second')).toThrow();
    sql.exec("UPDATE reward_requests SET status = 'received' WHERE request_id = 'first'");
    insert('second');
    expect(sql.exec<{ request_id: string }>('SELECT request_id FROM reward_requests ORDER BY seq').toArray())
      .toEqual([{ request_id: 'first' }, { request_id: 'second' }]);
  });
});
