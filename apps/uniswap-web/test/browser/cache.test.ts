import { expect, it } from 'vitest';
import type { Address, Bytes32, Scope } from '@confidential-utxo/uniswap';
import { createIndexedDbCipherCache } from '../../src/live/cache.js';
const recordId = `0x${'22'.repeat(32)}` as Bytes32;
const scope = { deploymentId: 'browser-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const entry = { recordId, revision: 2, updatedAt: 7,
  encryptedBundle: { nonce: `0x${'33'.repeat(12)}`, ciphertext: 'AQ==', tag: `0x${'44'.repeat(16)}` } };

it('persists ciphertext after reopening IndexedDB and partitions owner and deployment', async () => {
  await createIndexedDbCipherCache().write(scope, recordId, entry);
  const reopened = createIndexedDbCipherCache();
  expect(await reopened.read(scope, recordId)).toEqual(entry);
  expect(await reopened.read({ ...scope, owner: `0x${'55'.repeat(20)}` } as Scope, recordId)).toBeUndefined();
  expect(await reopened.read({ ...scope, deploymentId: 'browser-v2' } as Scope, recordId)).toBeUndefined();
});

it('treats blocked IndexedDB as an optional cache miss', async () => {
  const blocked = createIndexedDbCipherCache(null);
  await blocked.write(scope, recordId, entry);
  expect(await blocked.read(scope, recordId)).toBeUndefined();
});

it('recovers verified server and chain state with IndexedDB blocked', async () => {
  const { sealRecord } = await import('../../src/live/record-crypto.js');
  const { Recovery } = await import('../../src/live/recovery.js');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const operationId = `0x${'66'.repeat(32)}` as Bytes32;
  const pool = `0x${'77'.repeat(20)}` as Address;
  const encryptedBundle = await sealRecord(key, { ...scope, chainId: 11155111n, pool,
    recordId, revision: 1 }, { version: 1, creationInputs: {}, operationId,
    intendedAuthorization: {}, attempts: [], recoveryMarkers: {} });
  const saved = { scope, revision: 1, record: { kind: 'withdraw', scope, recordId,
    inputId: `0x${'88'.repeat(32)}`, operationId, contentHash: `0x${'99'.repeat(32)}`,
    encryptedBundle, signatureStarted: false, attemptIds: [] } };
  const recovery = new Recovery({ cache: createIndexedDbCipherCache(null), chainId: 11155111n, pool,
    http: { call: async () => ({ availability: 'healthy', records: [saved] }) } as never,
    chain: { readFinalized: async () => ({ outputs: [] }) } });
  const result = await recovery.load(scope, key);
  expect(result.availability).toBe('healthy');
  expect(result.records).toHaveLength(1);
});
