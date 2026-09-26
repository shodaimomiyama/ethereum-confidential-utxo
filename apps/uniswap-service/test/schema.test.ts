import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { resolveDeployment } from '../src/config.js';
import { applyMigrations } from '../src/schema.js';

it('rejects an unregistered deployment instead of sharing a default object', () => {
  const deployments = {
    'local-v1': {
      origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337,
      pool: '0x0000000000000000000000000000000000000001',
    },
  };
  expect(() => resolveDeployment('missing', deployments)).toThrow(/UNKNOWN_DEPLOYMENT/);
  expect(resolveDeployment('local-v1', deployments).origin).toBe('https://site.test');
});

it('keeps SQLite rows across schema reapplication', async () => {
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec("INSERT INTO sessions (session_hash, deployment_id, owner, expires_at_ms) VALUES ('x', 'local-v1', 'owner', 1000)");
  });
  await runInDurableObject(stub, (_object, state) => applyMigrations(state.storage));
  const versions = await runInDurableObject(stub, (_object, state) =>
    state.storage.sql.exec<{ version: number }>('SELECT version FROM migration_registry ORDER BY version').toArray());
  const sessions = await runInDurableObject(stub, (_object, state) =>
    state.storage.sql.exec<{ session_hash: string }>('SELECT session_hash FROM sessions').toArray());
  expect(versions.map(({ version }) => version)).toEqual([1]);
  expect(sessions.map(({ session_hash }) => session_hash)).toEqual(['x']);
});
