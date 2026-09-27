import type { OperationId, RequestId, Scope } from '@confidential-utxo/uniswap';
import type { DepositAttemptGate } from './deposit.js';
import type { RewardRequestMarker } from './reward-operation.js';

const DATABASE = 'confidential-utxo-uniswap-durable-markers';
const REWARDS = 'reward-requests';
const DEPOSITS = 'deposit-attempts';
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;

function scopeKey(scope: Scope): string {
  if (typeof scope.deploymentId !== 'string' || !scope.deploymentId ||
    typeof scope.owner !== 'string' || !address.test(scope.owner)) throw new Error('INVALID_MARKER_SCOPE');
  return JSON.stringify([scope.deploymentId, scope.owner.toLowerCase()]);
}

function depositKey(scope: Scope, operationId: OperationId): string {
  if (!hex32.test(operationId)) throw new Error('INVALID_OPERATION_ID');
  return JSON.stringify([scopeKey(scope), operationId.toLowerCase()]);
}

function validStoredId(value: unknown): value is { readonly requestId: RequestId } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && 'requestId' in value &&
    typeof value.requestId === 'string' && hex32.test(value.requestId);
}

function validStoredToken(value: unknown): value is { readonly token: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && 'token' in value &&
    typeof value.token === 'string' && hex32.test(value.token);
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REWARDS)) db.createObjectStore(REWARDS);
      if (!db.objectStoreNames.contains(DEPOSITS)) db.createObjectStore(DEPOSITS);
    };
    request.onblocked = () => { blocked = true; reject(new Error('MARKER_STORAGE_BLOCKED')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** The result is acknowledged only by transaction.oncomplete, after every write commits. */
function transaction<T>(db: IDBDatabase, storeName: string, key: string,
  decide: (value: unknown, store: IDBObjectStore) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('MARKER_TRANSACTION_ABORTED'));
    tx.onerror = () => reject(tx.error ?? new Error('MARKER_TRANSACTION_FAILED'));
    const read = store.get(key);
    read.onsuccess = () => {
      try { result = decide(read.result, store); }
      catch { try { tx.abort(); } catch { /* The transaction may already be aborting. */ } }
    };
  });
}

function browserFactory(factory: IDBFactory | null | undefined): IDBFactory | undefined {
  return factory === undefined ? globalThis.indexedDB : factory ?? undefined;
}

/** A profile-local recovery marker. Clearing browser data also clears these reservations. */
export function createIndexedDbRewardRequestMarker(factory?: IDBFactory | null): RewardRequestMarker {
  async function run<T>(scope: Scope, decide: (value: unknown, store: IDBObjectStore, key: string) => T): Promise<T | 'unknown'> {
    let db: IDBDatabase | undefined;
    try {
      const selected = browserFactory(factory);
      if (!selected) return 'unknown';
      const key = scopeKey(scope);
      db = await open(selected);
      return await transaction(db, REWARDS, key, (value, store) => decide(value, store, key));
    } catch { return 'unknown'; }
    finally { db?.close(); }
  }
  return {
    async read(scope) {
      const result = await run(scope, value => value === undefined ? { kind: 'absent' as const }
        : validStoredId(value) ? { kind: 'saved' as const, requestId: value.requestId }
        : { kind: 'unknown' as const });
      return result === 'unknown' ? { kind: 'unknown' } : result;
    },
    async reserve(scope, requestId) {
      if (!hex32.test(requestId)) throw new Error('INVALID_REQUEST_ID');
      return run(scope, (value, store, key) => {
        if (value !== undefined) return validStoredId(value) ? 'occupied' as const : 'unknown' as const;
        store.add({ requestId }, key);
        return 'saved' as const;
      });
    },
    async replace(scope, expected, next) {
      if (!hex32.test(expected) || (next !== undefined && !hex32.test(next))) throw new Error('INVALID_REQUEST_ID');
      return run(scope, (value, store, key) => {
        if (value !== undefined && !validStoredId(value)) return 'unknown' as const;
        if (value === undefined || value.requestId.toLowerCase() !== expected.toLowerCase()) return 'mismatch' as const;
        if (next === undefined) store.delete(key);
        else store.put({ requestId: next }, key);
        return 'saved' as const;
      });
    },
  };
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** A profile-local send guard; active claims need external chain reconciliation. */
export function createIndexedDbDepositAttemptGate(factory?: IDBFactory | null): DepositAttemptGate {
  async function run<T>(scope: Scope, operationId: OperationId,
    decide: (value: unknown, store: IDBObjectStore, key: string) => T): Promise<T | 'unknown'> {
    let db: IDBDatabase | undefined;
    try {
      const selected = browserFactory(factory);
      if (!selected) return 'unknown';
      const key = depositKey(scope, operationId);
      db = await open(selected);
      return await transaction(db, DEPOSITS, key, (value, store) => decide(value, store, key));
    } catch { return 'unknown'; }
    finally { db?.close(); }
  }
  return {
    async claim(scope, operationId) {
      let token: string;
      try { token = newToken(); } catch { return { status: 'unknown' }; }
      const result = await run(scope, operationId, (value, store, key) => {
        if (value !== undefined) return validStoredToken(value) ? { status: 'active' as const } : { status: 'unknown' as const };
        store.add({ token }, key);
        return { status: 'claimed' as const, token };
      });
      return result === 'unknown' ? { status: 'unknown' } : result;
    },
    async release(scope, operationId, token) {
      if (!hex32.test(token)) return 'unknown';
      return run(scope, operationId, (value, store, key) => {
        if (!validStoredToken(value) || value.token !== token) return 'unknown' as const;
        store.delete(key);
        return 'released' as const;
      });
    },
  };
}
