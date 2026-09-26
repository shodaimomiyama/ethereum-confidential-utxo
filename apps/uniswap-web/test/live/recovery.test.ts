import { expect, it } from 'vitest';
import type { Address, Bytes32, InputId, OperationId, OperationRecord, SavedOperation, Scope } from '@confidential-utxo/uniswap';
import { HttpFailure, type HttpClient } from '../../src/live/http.js';
import { sealRecord } from '../../src/live/record-crypto.js';
import { Recovery, type ChainReader, type FinalizedHistory } from '../../src/live/recovery.js';
import type { CipherCache } from '../../src/live/cache.js';

const id = (byte: string) => `0x${byte.repeat(64)}` as Bytes32;
const scope = { deploymentId: 'sepolia-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const pool = `0x${'22'.repeat(20)}` as Address;
const secret = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const plain = { version: 1 as const, creationInputs: { input: id('2') }, operationId: id('3'),
  intendedAuthorization: { input: id('2') }, attempts: [], recoveryMarkers: { phase: 'reserved' } };

async function fixture(revision = 1) {
  const key = await secret();
  const encryptedBundle = await sealRecord(key, { ...scope, chainId: 11155111n, pool, recordId: id('4'), revision }, plain);
  const record: OperationRecord = { kind: 'withdraw', scope, recordId: id('4'), inputId: id('2') as unknown as InputId,
    operationId: id('3') as unknown as OperationId, contentHash: id('5'), encryptedBundle, signatureStarted: false, attemptIds: [] };
  return { key, saved: { scope, record, revision } as SavedOperation & { scope: Scope } };
}

function deps(saved: SavedOperation & { scope: Scope }, options: {
  server?: 'healthy' | 'rollback' | 'unavailable'; chain?: FinalizedHistory | Error;
  cache?: CipherCache; records?: readonly (SavedOperation & { scope: Scope })[];
} = {}) {
  const http = { call: async (route: string) => {
    if (route !== 'GET /v1/operations') throw new Error('unexpected route');
    if (options.server === 'unavailable') throw new HttpFailure('api', 'SERVICE_UNAVAILABLE');
    return { availability: options.server ?? 'healthy', records: options.records ?? [saved] };
  } } as HttpClient;
  const chain: ChainReader = { readFinalized: async () => {
    if (options.chain instanceof Error) throw options.chain;
    return options.chain ?? { outputs: [] };
  } };
  return new Recovery({ http, chain, cache: options.cache, chainId: 11155111n, pool });
}

it('loads authenticated server records with healthy chain when IndexedDB is absent', async () => {
  const { key, saved } = await fixture();
  const result = await deps(saved).load(scope, key);
  expect(result.availability).toBe('healthy');
  expect(result.records).toEqual([{ saved, plaintext: { ...plain } }]);
  expect(result.allowedActions).toContain('new-authorization-eligible');
});

it('ignores a stale cache revision and a quota write failure', async () => {
  const { key, saved } = await fixture(2);
  const cache: CipherCache = { read: async () => ({ recordId: id('4'), revision: 1,
    encryptedBundle: saved.record.encryptedBundle, updatedAt: 1 }), write: async () => { throw new DOMException('quota', 'QuotaExceededError'); } };
  const result = await deps(saved, { cache }).load(scope, key);
  expect(result.availability).toBe('healthy');
  expect(result.records[0]?.saved.revision).toBe(2);
});

it.each(['rollback', 'unavailable'] as const)('blocks new authorization on %s server', async status => {
  const { key, saved } = await fixture();
  const result = await deps(saved, { server: status }).load(scope, key);
  expect(result.availability).toBe(status);
  expect(result.records).toEqual([]);
  expect(result.allowedActions).not.toContain('new-authorization-eligible');
  expect(result.allowedActions).not.toContain('start:pay');
});

it('does not recover a different owner or deployment record', async () => {
  const { key, saved } = await fixture();
  const other = { ...saved, scope: { ...scope, owner: `0x${'99'.repeat(20)}` } as Scope };
  expect((await deps(saved, { records: [other] }).load(scope, key)).availability).toBe('unknown');
  const another = { ...saved, scope: { ...scope, deploymentId: 'other' } as Scope };
  expect((await deps(saved, { records: [another] }).load(scope, key)).availability).toBe('unknown');
});

it('blocks new authorization when server revision or ciphertext fails AAD authentication', async () => {
  const { key, saved } = await fixture();
  const wrongRevision = { ...saved, revision: 2 };
  expect((await deps(saved, { records: [wrongRevision] }).load(scope, key)).availability).toBe('unknown');
  const tampered = { ...saved, record: { ...saved.record, encryptedBundle: {
    ...saved.record.encryptedBundle, tag: `0x${'ff'.repeat(16)}` } } } as typeof saved;
  const result = await deps(saved, { records: [tampered] }).load(scope, key);
  expect(result.availability).toBe('unknown');
  expect(result.allowedActions).toEqual([]);
});

it('deduplicates finalized output IDs without claiming spendability', async () => {
  const { key, saved } = await fixture();
  const output = { outputId: id('6'), operationId: id('3'), blockHash: id('7') };
  const result = await deps(saved, { chain: { outputs: [output, output] } }).load(scope, key);
  expect(result.finalized.outputs).toEqual([output]);
  expect(result).not.toHaveProperty('spendableOutputs');
});

it('reports chain failure as unknown even with a healthy server', async () => {
  const { key, saved } = await fixture();
  const result = await deps(saved, { chain: new Error('RPC_FAILED') }).load(scope, key);
  expect(result.availability).toBe('unknown');
  expect(result.allowedActions).toEqual([]);
});
