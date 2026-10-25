import type { Bytes32, EncryptedBundle, Scope } from '@confidential-utxo/uniswap';

export interface CachedCiphertext {
  readonly recordId: Bytes32;
  readonly revision: number;
  readonly encryptedBundle: EncryptedBundle;
  readonly updatedAt: number;
}

/** A disposable hint. No method on this port establishes authorization or record freshness. */
export interface CipherCache {
  read(scope: Scope, recordId: Bytes32): Promise<CachedCiphertext | undefined>;
  write(scope: Scope, recordId: Bytes32, entry: CachedCiphertext): Promise<void>;
}

const DB_NAME = 'confidential-utxo-uniswap-cipher-cache';
const STORE_NAME = 'records';
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
function cacheKey(scope: Scope, recordId: Bytes32): string {
  if (!scope.deploymentId || !address.test(scope.owner) || !hex32.test(recordId)) throw new Error('INVALID_CACHE_KEY');
  return JSON.stringify([scope.deploymentId, scope.owner.toLowerCase(), recordId.toLowerCase()]);
}
function safeEntry(recordId: Bytes32, entry: CachedCiphertext): CachedCiphertext {
  if (recordId.toLowerCase() !== entry.recordId.toLowerCase()
    || !Number.isSafeInteger(entry.revision) || entry.revision < 1
    || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0
    || !/^0x[0-9a-fA-F]{24}$/.test(entry.encryptedBundle.nonce)
    || !/^0x[0-9a-fA-F]{32}$/.test(entry.encryptedBundle.tag)
    || typeof entry.encryptedBundle.ciphertext !== 'string') throw new Error('INVALID_CACHE_ENTRY');
  return { recordId, revision: entry.revision, updatedAt: entry.updatedAt,
    encryptedBundle: { nonce: entry.encryptedBundle.nonce, ciphertext: entry.encryptedBundle.ciphertext,
      tag: entry.encryptedBundle.tag } };
}
function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('CACHE_BLOCKED'));
  });
}
function transact<T>(database: IDBDatabase, mode: IDBTransactionMode, key: string, value?: CachedCiphertext): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = mode === 'readonly' ? transaction.objectStore(STORE_NAME).get(key)
      : transaction.objectStore(STORE_NAME).put(value, key);
    let result: T;
    request.onsuccess = () => { result = request.result as T; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createIndexedDbCipherCache(factory: IDBFactory | null | undefined = globalThis.indexedDB): CipherCache {
  return {
    async read(scope, recordId) {
      const key = cacheKey(scope, recordId);
      if (!factory) return undefined;
      let database: IDBDatabase | undefined;
      try {
        database = await open(factory);
        const value = await transact<unknown>(database, 'readonly', key);
        if (!value || typeof value !== 'object') return undefined;
        return safeEntry(recordId, value as CachedCiphertext);
      } catch { return undefined; }
      finally { database?.close(); }
    },
    async write(scope, recordId, entry) {
      const key = cacheKey(scope, recordId);
      const value = safeEntry(recordId, entry);
      if (!factory) return;
      let database: IDBDatabase | undefined;
      try {
        database = await open(factory);
        await transact(database, 'readwrite', key, value);
      } catch { /* Cache failures never change durable record status. */ }
      finally { database?.close(); }
    },
  };
}
