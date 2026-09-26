import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { registerServiceExtension, getServiceExtensions, makeServiceContext } from '../src/extensions.js';
import type { UniswapServiceObject } from '../src/durable-object.js';

it('uses the same SQLite transaction and rejects duplicate migration versions', async () => {
  const extension = {
    migrations: [{ version: 200, statements: ['CREATE TABLE extension_test (id INTEGER PRIMARY KEY)'] }],
    routes: [],
    alarm: async (context: ReturnType<typeof makeServiceContext>) => {
      context.transactionSync(() => context.storage.sql.exec('INSERT OR IGNORE INTO extension_test (id) VALUES (2)'));
    },
  };
  registerServiceExtension(extension);
  expect(getServiceExtensions()).toContain(extension);
  expect(() => registerServiceExtension({ ...extension })).toThrow('DUPLICATE_MIGRATION_VERSION');
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('extension-test'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_obj, state) => {
    await state.storage.put('deploymentId', 'local-v1');
    const context = makeServiceContext(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    context.transactionSync(() => state.storage.sql.exec('INSERT INTO extension_test (id) VALUES (1)'));
    expect(state.storage.sql.exec<{ id: number }>('SELECT id FROM extension_test').toArray()).toEqual([{ id: 1 }]);
    expect(() => makeServiceContext(state.storage, { generation: 'test-g2', stopped: true }).ensureWritable())
      .toThrow('SERVICE_UNAVAILABLE');
  });
  await runInDurableObject(stub, async (object) => {
    await (object as UniswapServiceObject).alarm();
    await (object as UniswapServiceObject).alarm();
  });
  const rows = await runInDurableObject(stub, (_obj, state) =>
    state.storage.sql.exec<{ id: number }>('SELECT id FROM extension_test ORDER BY id').toArray());
  expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
});
