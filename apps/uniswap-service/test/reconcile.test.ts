import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';
import { putOperation } from '../src/store.js';
import { reconcileOperation, type FinalizedView } from '../src/reconcile.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'ef'.repeat(20)}` } as Scope;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const hash = id(500);
const record = (n: number, kind: 'pay' | 'withdraw' = 'pay') => ({
  scope, recordId: id(n), inputId: id(99), operationId: id(n), contentHash: id(n),
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
  signatureStarted: false, attemptIds: [],
  ...(kind === 'pay' ? { kind, paymentId: id(n), deadline: 600n } : { kind }),
}) as unknown as OperationRecord;
const inputReader = { readInput: async () => 'owned-unspent' as const };
const view = (timestamp: string, inputSpent = false, paySucceeded = false): FinalizedView => ({
  checkpoint: { blockNumber: '10', blockHash: hash as FinalizedView['checkpoint']['blockHash'], blockTimestamp: timestamp },
  input: { blockHash: hash, spent: inputSpent },
  pay: { blockHash: hash, succeeded: paySucceeded },
});

it('releases Pay only after strict deadline with one consistent finalized view', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reconcile-pay'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(1), 0, inputReader));
  const atDeadline = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(1),
    { readFinalizedView: async () => view('600') }));
  expect(atDeadline.status).toBe('reserved');
  const mixed = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(1),
    { readFinalizedView: async () => ({ ...view('601'), pay: { blockHash: id(501), succeeded: false } }) }));
  expect(mixed.status).toBe('unknown');
  const released = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(1),
    { readFinalizedView: async () => view('601') }));
  expect(released.status).toBe('released');
  expect(released.revision).toBe(1);
  expect(released.stateVersion).toBeGreaterThan(1);
  await expect(runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(1), 1, inputReader)))
    .resolves.toHaveProperty('status', 'released');
  const successor = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(2), 0, inputReader));
  expect(successor.status).toBe('reserved');
  const reorg = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(1),
    { readFinalizedView: async () => ({ ...view('601', true, true), checkpoint: {
      blockNumber: '10', blockHash: id(502) as FinalizedView['checkpoint']['blockHash'], blockTimestamp: '601',
    }, input: { blockHash: id(502), spent: true }, pay: { blockHash: id(502), succeeded: true } }) }));
  expect(reorg.status).toBe('unknown');
  const environment = await runInDurableObject(stub, (_obj, state) =>
    state.storage.sql.exec<{ status: string }>('SELECT status FROM environment_state WHERE id = 1').toArray()[0]);
  expect(environment?.status).toBe('stopped');
});

it('keeps Withdraw reserved after expiry and never releases a consumed input or successful Pay', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reconcile-withdraw'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record(3, 'withdraw'), 0, inputReader));
  const withdraw = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(3),
    { readFinalizedView: async () => view('9999') }));
  expect(withdraw.status).toBe('reserved');
  const consumed = await runInDurableObject(stub, (_obj, state) => reconcileOperation(state.storage, scope, id(3),
    { readFinalizedView: async () => view('9999', true) }));
  expect(consumed.status).toBe('consumed');
});
