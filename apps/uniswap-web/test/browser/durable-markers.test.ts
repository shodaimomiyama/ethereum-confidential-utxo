import { expect, it } from 'vitest';
import type { OperationId, RequestId, Scope } from '@confidential-utxo/uniswap';
import { createIndexedDbDepositAttemptGate, createIndexedDbRewardRequestMarker } from '../../src/live/durable-markers.js';

const id = (byte: string) => `0x${byte.repeat(64)}` as RequestId;
const operation = id('a') as unknown as OperationId;
function scope(): Scope {
  return { deploymentId: `test-${crypto.randomUUID()}`, owner: `0x${'11'.repeat(20)}` } as Scope;
}

it('reserves one request across concurrent instances and survives reopening', async () => {
  const current = scope();
  const markers = Array.from({ length: 16 }, () => createIndexedDbRewardRequestMarker());
  const outcomes = await Promise.all(markers.map((marker, i) => marker.reserve(current, id(i.toString(16)))));
  expect(outcomes.filter(value => value === 'saved')).toHaveLength(1);
  expect(outcomes.filter(value => value === 'occupied')).toHaveLength(15);
  const winner = id(outcomes.indexOf('saved').toString(16));
  const reopened = createIndexedDbRewardRequestMarker();
  expect(await reopened.read(current)).toEqual({ kind: 'saved', requestId: winner });
  expect(await reopened.read({ ...current, owner: `0x${'22'.repeat(20)}` } as Scope)).toEqual({ kind: 'absent' });
  expect(await reopened.read({ ...current, deploymentId: `${current.deploymentId}-other` } as Scope)).toEqual({ kind: 'absent' });
  expect(await reopened.replace(current, id('f'), undefined)).toBe('mismatch');
  expect(await reopened.replace(current, winner, id('b'))).toBe('saved');
  expect(await markers[0]!.read(current)).toEqual({ kind: 'saved', requestId: id('b') });
  expect(await reopened.replace(current, id('b'), undefined)).toBe('saved');
  expect(await reopened.read(current)).toEqual({ kind: 'absent' });
});

it('allows one deposit claim across concurrent instances and requires its token to release', async () => {
  const current = scope();
  const gates = Array.from({ length: 16 }, () => createIndexedDbDepositAttemptGate());
  const results = await Promise.all(gates.map(gate => gate.claim(current, operation)));
  const claimed = results.filter(result => result.status === 'claimed');
  expect(claimed).toHaveLength(1);
  expect(results.filter(result => result.status === 'active')).toHaveLength(15);
  const token = claimed[0]!.status === 'claimed' ? claimed[0]!.token : '';
  expect(token).toMatch(/^0x[0-9a-f]{64}$/);
  const reopened = createIndexedDbDepositAttemptGate();
  expect(await reopened.claim(current, operation)).toEqual({ status: 'active' });
  expect(await reopened.claim({ ...current, owner: `0x${'22'.repeat(20)}` } as Scope, operation)).toMatchObject({ status: 'claimed' });
  expect(await reopened.claim({ ...current, deploymentId: `${current.deploymentId}-other` } as Scope, operation)).toMatchObject({ status: 'claimed' });
  expect(await reopened.release(current, operation, id('f'))).toBe('unknown');
  expect(await reopened.claim(current, operation)).toEqual({ status: 'active' });
  expect(await reopened.release(current, operation, token)).toBe('released');
  expect(await reopened.release(current, operation, token)).toBe('unknown');
  const afterRelease = await reopened.claim(current, operation);
  expect(afterRelease.status).toBe('claimed');
  if (afterRelease.status === 'claimed') expect(afterRelease.token).not.toBe(token);
});

it('fails closed when IndexedDB is unavailable or a stored value is malformed', async () => {
  const current = scope();
  const unavailableMarker = createIndexedDbRewardRequestMarker(null);
  const unavailableGate = createIndexedDbDepositAttemptGate(null);
  expect(await unavailableMarker.read(current)).toEqual({ kind: 'unknown' });
  expect(await unavailableMarker.reserve(current, id('1'))).toBe('unknown');
  expect(await unavailableMarker.replace(current, id('1'), undefined)).toBe('unknown');
  expect(await unavailableGate.claim(current, operation)).toEqual({ status: 'unknown' });
  expect(await unavailableGate.release(current, operation, id('1'))).toBe('unknown');

  // Inject malformed public records through Chrome's real IndexedDB API.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('confidential-utxo-uniswap-durable-markers', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['reward-requests', 'deposit-attempts'], 'readwrite');
      tx.objectStore('reward-requests').put({ requestId: id('2'), secret: 'must-not-be-accepted' },
        JSON.stringify([current.deploymentId, current.owner.toLowerCase()]));
      tx.objectStore('deposit-attempts').put({ token: 'invalid' },
        JSON.stringify([JSON.stringify([current.deploymentId, current.owner.toLowerCase()]), operation.toLowerCase()]));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
  expect(await createIndexedDbRewardRequestMarker().read(current)).toEqual({ kind: 'unknown' });
  expect(await createIndexedDbRewardRequestMarker().reserve(current, id('3'))).toBe('unknown');
  expect(await createIndexedDbDepositAttemptGate().claim(current, operation)).toEqual({ status: 'unknown' });
});

it('does not acknowledge a reservation whose IndexedDB transaction aborts', async () => {
  const current = scope();
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalAdd.call(this, value, key);
    if (this.name === 'reward-requests') queueMicrotask(() => this.transaction.abort());
    return request;
  } as typeof IDBObjectStore.prototype.add;
  try {
    expect(await createIndexedDbRewardRequestMarker().reserve(current, id('4'))).toBe('unknown');
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }
  expect(await createIndexedDbRewardRequestMarker().read(current)).toEqual({ kind: 'absent' });
});
