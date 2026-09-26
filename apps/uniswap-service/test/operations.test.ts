import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';
import { putOperation, listOperations } from '../src/store.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'ab'.repeat(20)}` } as Scope;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as OperationRecord['recordId'];
const record = (n: number, kind: 'pay' | 'withdraw' = 'pay'): OperationRecord => ({
  scope, recordId: id(n), inputId: id(99), operationId: id(n), contentHash: id(n),
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
  signatureStarted: false, attemptIds: [],
  ...(kind === 'pay' ? { kind, paymentId: id(n), deadline: 600n } : { kind }),
}) as unknown as OperationRecord;
const reader = { readInput: async () => 'owned-unspent' as const };

it('atomically admits one pay or withdraw reservation per input and preserves history', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('store-test-1'));
  await stub.fetch('https://site.test/v1/operations');
  const result = await Promise.allSettled([
    runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(1), 0, reader)),
    runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(2, 'withdraw'), 0, reader)),
  ]);
  expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
  const rows = await runInDurableObject(stub, (_obj, state) => listOperations(state.storage, scope));
  expect(rows.records).toHaveLength(1);
});

it('fails closed when input ownership cannot be checked', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('store-test-2'));
  await stub.fetch('https://site.test/v1/operations');
  await expect(runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(3), 0,
    { readInput: async () => 'unknown' as const }))).rejects.toThrow('SERVICE_UNAVAILABLE');
});

it('requires a reservation ACK before signature-started state', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('store-test-4'));
  await stub.fetch('https://site.test/v1/operations');
  await expect(runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope,
    { ...record(5), signatureStarted: true }, 0, reader))).rejects.toThrow('REVISION_CONFLICT');
});

it('accepts exact retries, rejects stale changes and keeps signatureStarted monotonic', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('store-test-3'));
  await stub.fetch('https://site.test/v1/operations');
  const initial = record(4);
  const first = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, initial, 0, reader));
  expect(first.revision).toBe(1);
  const retry = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, initial, 0, reader));
  expect(retry).toEqual(first);
  const started = { ...initial, signatureStarted: true };
  await expect(runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, started, 0, reader)))
    .rejects.toThrow('REVISION_CONFLICT');
  const second = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, started, 1, reader));
  expect(second.revision).toBe(2);
  await expect(runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope,
    { ...initial, encryptedBundle: { ...initial.encryptedBundle, ciphertext: 'Ag==' } }, 2, reader)))
    .rejects.toThrow('REVISION_CONFLICT');
});
