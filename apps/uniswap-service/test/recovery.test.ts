import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { beginRestore, completeRestore, getAvailability, ensureWritable, initializeEnvironment } from '../src/recovery.js';

it('keeps an old healthy database stopped by the external gate', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('recovery-test'));
  await stub.fetch('https://site.test/v1/operations');
  const healthy = { generation: 'g1', stopped: false, initialize: true };
  await runInDurableObject(stub, (_obj, state) => {
    expect(getAvailability(state.storage, healthy)).toBe('rollback');
    initializeEnvironment(state.storage, healthy);
    expect(getAvailability(state.storage, healthy)).toBe('healthy');
  });
  await runInDurableObject(stub, (_obj, state) => beginRestore(state.storage, { generation: 'g2', stopped: true }));
  await runInDurableObject(stub, (_obj, state) => {
    expect(getAvailability(state.storage, { generation: 'g2', stopped: true })).toBe('rollback');
    expect(() => ensureWritable(state.storage, { generation: 'g2', stopped: true })).toThrow('SERVICE_UNAVAILABLE');
  });
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec("UPDATE environment_state SET status = 'healthy', generation = 'g1' WHERE id = 1");
    expect(getAvailability(state.storage, { generation: 'g2', stopped: true })).toBe('rollback');
    expect(getAvailability(state.storage, { generation: 'g2', stopped: false })).toBe('rollback');
  });
  await expect(runInDurableObject(stub, (_obj, state) => completeRestore(state.storage,
    { generation: 'g2', stopped: true }, { acknowledgedRecordsComplete: false, chainReconciled: true })))
    .rejects.toThrow('RESTORE_EVIDENCE_INCOMPLETE');
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec('DELETE FROM environment_state WHERE id = 1');
    expect(getAvailability(state.storage, healthy)).toBe('rollback');
    expect(() => ensureWritable(state.storage, healthy)).toThrow('SERVICE_UNAVAILABLE');
  });
});
