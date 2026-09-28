import { expect, it, vi } from 'vitest';
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

async function fixture(revision = 1, plaintext: typeof plain | (typeof plain & { paymentId: Bytes32 }) = plain) {
  const key = await secret();
  const encryptedBundle = await sealRecord(key, { ...scope, chainId: 11155111n, pool, recordId: id('4'), revision }, plaintext);
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

it('rejects a withdraw record whose authenticated plaintext contains a payment ID', async () => {
  const { key, saved } = await fixture(1, { ...plain, paymentId: id('a') });
  const result = await deps(saved).load(scope, key);
  expect(result.availability).toBe('unknown');
  expect(result.allowedActions).toEqual([]);
});

it('returns verified recovery while an optional cache write never settles', async () => {
  const { key, saved } = await fixture();
  const cache: CipherCache = { read: async () => undefined,
    write: async () => new Promise<void>(() => {}) };
  const outcome = await Promise.race([
    deps(saved, { cache }).load(scope, key),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CACHE_BLOCKED_RECOVERY')), 100)),
  ]);
  expect(outcome.availability).toBe('healthy');
  expect(outcome.records).toHaveLength(1);
});

async function pagedFixture() {
  const { key, saved } = await fixture();
  const records = await Promise.all(Array.from({ length: 101 }, async (_, i) => {
    const recordId = `0x${(i + 1).toString(16).padStart(64, '0')}` as Bytes32;
    const encryptedBundle = await sealRecord(key, { ...scope, chainId: 11155111n, pool, recordId, revision: 1 }, plain);
    return { ...saved, record: { ...saved.record, recordId, encryptedBundle },
      status: 'reserved' as const, stateVersion: 7 };
  }));
  return { key, records };
}

it('recovers more than 100 records and preserves lifecycle metadata independently of AAD revision', async () => {
  const { key, records } = await pagedFixture();
  const call = vi.fn(async (_route: string, input: { cursor?: Bytes32 }) => ({ availability: 'healthy',
    records: input.cursor === undefined ? records.slice(0, 100) : records.slice(100),
    ...(input.cursor === undefined ? { nextCursor: records[99]!.record.recordId } : {}),
  }));
  const recovery = new Recovery({ http: { call } as HttpClient, chain: { readFinalized: async () => ({ outputs: [] }) }, chainId: 11155111n, pool });
  const result = await recovery.load(scope, key);
  expect(result.availability).toBe('healthy');
  expect(result.records).toHaveLength(101);
  expect(result.records[100]!.saved).toMatchObject({ revision: 1, stateVersion: 7, status: 'reserved' });
  expect(call.mock.calls[1]![1].cursor).toBe(records[99]!.record.recordId);
});

it.each(['rollback', '503', 'cycle', 'duplicate', 'scope', 'aad', 'empty', 'empty-terminal', 'backward', 'skipped'] as const)(
  'blocks authorization and cache publication on a later-page %s', async failure => {
    const { key, records } = await pagedFixture();
    const readFinalized = vi.fn(async () => ({ outputs: [] }));
    const write = vi.fn(async () => {});
    let page = 0;
    const call = vi.fn(async () => {
      if (page++ === 0) return { availability: 'healthy', records: records.slice(0, 100), nextCursor: records[99]!.record.recordId };
      if (failure === '503') throw new HttpFailure('api', 'SERVICE_UNAVAILABLE');
      const last = records[100]!;
      return { availability: failure === 'rollback' ? 'rollback' : 'healthy',
        records: failure === 'empty' || failure === 'empty-terminal' ? [] : [failure === 'duplicate' ? records[0]!
          : failure === 'scope' ? { ...last, scope: { ...scope, deploymentId: 'other' } }
          : failure === 'aad' ? { ...last, revision: 7 } : last],
        ...(['cycle', 'empty', 'backward', 'skipped'].includes(failure) ? { nextCursor: failure === 'backward'
          ? records[0]!.record.recordId : failure === 'skipped' ? id('f') : records[99]!.record.recordId } : {}),
      };
    });
    const recovery = new Recovery({ http: { call } as HttpClient, chain: { readFinalized },
      cache: { read: async () => undefined, write }, chainId: 11155111n, pool });
    const result = await recovery.load(scope, key);
    expect(result.availability).toBe(failure === 'rollback' ? 'rollback' : failure === '503' ? 'unavailable' : 'unknown');
    expect(result.records).toEqual([]);
    expect(result.allowedActions).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(readFinalized).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(2);
  });
