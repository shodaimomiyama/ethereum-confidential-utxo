import { expect, it } from 'vitest';
import { operationId as coreOperationId, outputId, type Context, type LocalDraft } from '@confidential-utxo/core';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import { createIndexedDbDepositStorage } from '../../src/live/deposit-storage.js';

const owner = `0x${'11'.repeat(20)}`;
const pool = `0x${'22'.repeat(20)}` as Address;
const context = { chainId: 31337n, pool, verifier: `0x${'44'.repeat(20)}` as const,
  deploymentBlock: 1n, parametersHash: `0x${'55'.repeat(32)}` as const,
  finalityMode: 'local-simulated' as const } satisfies Context;
const scope = () => ({ deploymentId: `draft-${crypto.randomUUID()}`, owner } as Scope);
const draft = (): LocalDraft => {
  const result = {
  context,
  request: { kind: 0, owner, salt: `0x${'66'.repeat(32)}`, inputIds: [], outputs: [{ owner,
    commitment: { x: 3n, y: 4n }, receiptFormat: 1, packet: '0x1234' }], d: 12n, w: 0n, destination: owner },
  operationId: `0x${'33'.repeat(32)}`, outputIds: [`0x${'77'.repeat(32)}`], openings: [{ amount: 12n, blinding: 9n }],
  inputOpenings: [], balanceProof: { Rx: 1n, Ry: 2n, s: 3n },
  rangeProofs: [{ coords: [1n], scalars: [2n], ls: [3n], rs: [4n] }], signature: `0x${'88'.repeat(65)}`,
  } as LocalDraft;
  result.operationId = coreOperationId(result.context, result.request);
  result.outputIds = [outputId(result.operationId, 0)];
  return result;
};
const operationId = draft().operationId;

async function key() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

it('saves encrypted draft through strict transaction, reopens and restores bigints with matching key', async () => {
  const current = scope();
  const secret = await key();
  const storage = createIndexedDbDepositStorage({ scope: current, context, key: secret });
  const original = draft();
  expect(await storage.saveDraft(original)).toBe('saved');
  expect(await storage.saveDraft(structuredClone(original))).toBe('saved');
  expect(await createIndexedDbDepositStorage({ scope: current, context, key: secret })
    .readDraft(operationId)).toEqual({ status: 'decrypted-unverified', draft: original });
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('confidential-utxo-uniswap-deposit-drafts', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const stored = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly');
    const request = tx.objectStore('drafts').get(JSON.stringify([current.deploymentId, owner.toLowerCase(), operationId.toLowerCase()]));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  expect(JSON.stringify(stored)).not.toContain('blinding');
  expect(JSON.stringify(stored)).not.toContain(original.signature);
  expect(Object.keys(stored as object).sort()).toEqual(['ciphertext', 'nonce', 'version']);
});

it('does not overwrite a different draft and partitions deployment and owner', async () => {
  const current = scope();
  const secret = await key();
  const storage = createIndexedDbDepositStorage({ scope: current, context, key: secret });
  const original = draft();
  expect(await storage.saveDraft(original)).toBe('saved');
  const changed = structuredClone(original);
  changed.openings[0] = { amount: 12n, blinding: 10n };
  expect(await storage.saveDraft(changed)).toBe('unknown');
  expect(await storage.readDraft(operationId)).toEqual({ status: 'decrypted-unverified', draft: original });
  expect(await createIndexedDbDepositStorage({ scope: { ...current, owner: `0x${'99'.repeat(20)}` } as Scope,
    context, key: secret }).readDraft(operationId)).toEqual({ status: 'absent' });
  expect(await createIndexedDbDepositStorage({ scope: { ...current, deploymentId: `${current.deploymentId}-next` } as Scope,
    context, key: secret }).readDraft(operationId)).toEqual({ status: 'absent' });
  expect(await createIndexedDbDepositStorage({ scope: current, context,
    key: await key() }).readDraft(operationId)).toEqual({ status: 'unknown' });
});

it('fails closed if IndexedDB is unavailable or strict durability is downgraded', async () => {
  const current = scope();
  const secret = await key();
  const unavailable = createIndexedDbDepositStorage({ scope: current, context,
    key: secret, factory: null });
  expect(await unavailable.saveDraft(draft())).toBe('unknown');
  expect(await unavailable.readDraft(operationId)).toEqual({ status: 'unknown' });
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(this: IDBDatabase, names: string | string[],
    mode?: IDBTransactionMode) {
    return originalTransaction.call(this, names, mode, mode === 'readwrite' ? { durability: 'relaxed' } : undefined);
  } as typeof IDBDatabase.prototype.transaction;
  try {
    expect(await createIndexedDbDepositStorage({ scope: current, context,
      key: secret }).saveDraft(draft())).toBe('unknown');
  } finally { IDBDatabase.prototype.transaction = originalTransaction; }
});

it('does not acknowledge an aborted write', async () => {
  const current = scope();
  const secret = await key();
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(this: IDBObjectStore, value: unknown, id?: IDBValidKey) {
    const request = originalAdd.call(this, value, id);
    if (this.name === 'drafts') queueMicrotask(() => this.transaction.abort());
    return request;
  } as typeof IDBObjectStore.prototype.add;
  try {
    expect(await createIndexedDbDepositStorage({ scope: current, context,
      key: secret }).saveDraft(draft())).toBe('unknown');
  } finally { IDBObjectStore.prototype.add = originalAdd; }
  expect(await createIndexedDbDepositStorage({ scope: current, context,
    key: secret }).readDraft(operationId)).toEqual({ status: 'absent' });
});

it('rejects recovery using the wrong chain or Pool even when the indexed key matches', async () => {
  const current = scope();
  const secret = await key();
  expect(await createIndexedDbDepositStorage({ scope: current, context,
    key: secret }).saveDraft(draft())).toBe('saved');
  expect(await createIndexedDbDepositStorage({ scope: current, context: { ...context, chainId: 1n },
    key: secret }).readDraft(operationId)).toEqual({ status: 'unknown' });
  expect(await createIndexedDbDepositStorage({ scope: current, context: { ...context, pool: `0x${'99'.repeat(20)}` as Address }, key: secret }).readDraft(operationId)).toEqual({ status: 'unknown' });
});

it('rejects a draft with mismatched operation and output IDs before durable acknowledgement', async () => {
  const current = scope();
  const storage = createIndexedDbDepositStorage({ scope: current, context, key: await key() });
  const wrongOperation = draft();
  wrongOperation.operationId = `0x${'99'.repeat(32)}`;
  expect(await storage.saveDraft(wrongOperation)).toBe('unknown');
  const wrongOutput = draft();
  wrongOutput.outputIds[0] = `0x${'99'.repeat(32)}`;
  expect(await storage.saveDraft(wrongOutput)).toBe('unknown');
  expect(await storage.readDraft(operationId)).toEqual({ status: 'absent' });
});

it('rejects a different verifier, parameters or deployment block in the same chain and Pool', async () => {
  const current = scope();
  const storage = createIndexedDbDepositStorage({ scope: current, context, key: await key() });
  for (const changed of [
    { verifier: `0x${'99'.repeat(20)}` },
    { parametersHash: `0x${'99'.repeat(32)}` },
    { deploymentBlock: 2n },
    { finalityMode: 'finalized' as const },
  ]) {
    const invalid = draft();
    invalid.context = { ...invalid.context, ...changed } as Context;
    expect(await storage.saveDraft(invalid)).toBe('unknown');
  }
});
