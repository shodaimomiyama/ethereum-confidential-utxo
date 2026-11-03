import { operationId as computeOperationId, outputId, type Context, type LocalDraft, type StoragePort } from '@confidential-utxo/core';
import type { Scope } from '@confidential-utxo/uniswap';

const DATABASE = 'confidential-utxo-uniswap-deposit-drafts';
const STORE = 'drafts';
const DOMAIN = 'ecu/uniswap/deposit-draft/v1';
const MAX_BYTES = 1_048_576;
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type SealedDraft = { readonly version: 1; readonly nonce: number[]; readonly ciphertext: number[] };
/** Decryption and identity checks do not establish current chain state or valid proofs.
 * Run the core prepareSubmission gate before using a recovered draft for authorization or send. */
export type DraftRead = { readonly status: 'decrypted-unverified'; readonly draft: LocalDraft } |
  { readonly status: 'absent' | 'unknown' };

export interface DepositStorageOptions {
  readonly scope: Scope;
  readonly context: Context;
  /** Nonextractable AES-GCM key from the scoped key session. Never persisted. */
  readonly key: CryptoKey;
  readonly factory?: IDBFactory | null;
}

function identity(options: DepositStorageOptions, operationId: string): { id: string; aad: Uint8Array<ArrayBuffer> } {
  const { scope, context } = options;
  if (typeof scope.deploymentId !== 'string' || !scope.deploymentId || !address.test(scope.owner) ||
    !address.test(context.pool) || !address.test(context.verifier) ||
    !hex32.test(context.parametersHash) || context.chainId <= 0n || context.deploymentBlock < 0n ||
    !['finalized', 'local-simulated'].includes(context.finalityMode) || !hex32.test(operationId)) {
    throw new Error('INVALID_DRAFT_SCOPE');
  }
  const owner = scope.owner.toLowerCase();
  const id = operationId.toLowerCase();
  return { id: JSON.stringify([scope.deploymentId, owner, id]),
    aad: encoder.encode(JSON.stringify([DOMAIN, scope.deploymentId, owner, context.chainId.toString(),
      context.pool.toLowerCase(), context.verifier.toLowerCase(), context.parametersHash.toLowerCase(),
      context.deploymentBlock.toString(), context.finalityMode, id])) };
}

function validate(draft: LocalDraft, options: DepositStorageOptions): void {
  if (!draft || typeof draft !== 'object' || !draft.context || !draft.request ||
    draft.context.chainId !== options.context.chainId ||
    draft.context.pool.toLowerCase() !== options.context.pool.toLowerCase() ||
    draft.context.verifier.toLowerCase() !== options.context.verifier.toLowerCase() ||
    draft.context.parametersHash.toLowerCase() !== options.context.parametersHash.toLowerCase() ||
    draft.context.deploymentBlock !== options.context.deploymentBlock ||
    draft.context.finalityMode !== options.context.finalityMode ||
    draft.request.owner.toLowerCase() !== options.scope.owner.toLowerCase() || draft.request.kind !== 0 ||
    !Array.isArray(draft.outputIds) || !Array.isArray(draft.openings) ||
    !Array.isArray(draft.inputOpenings) || !Array.isArray(draft.rangeProofs) || !draft.balanceProof) {
    throw new Error('INVALID_DEPOSIT_DRAFT');
  }
  identity(options, draft.operationId);
  if (computeOperationId(draft.context, draft.request).toLowerCase() !== draft.operationId.toLowerCase() ||
    draft.outputIds.length !== draft.request.outputs.length ||
    draft.outputIds.some((id, index) => id.toLowerCase() !== outputId(draft.operationId, index).toLowerCase())) {
    throw new Error('INVALID_DEPOSIT_DRAFT');
  }
}

function serialize(draft: LocalDraft): Uint8Array<ArrayBuffer> {
  const json = JSON.stringify(draft, (_key, value: unknown) => typeof value === 'bigint'
    ? { __ecuDepositBigint: value.toString(10) } : value);
  if (!json) throw new Error('INVALID_DEPOSIT_DRAFT');
  const bytes = encoder.encode(json);
  if (bytes.length > MAX_BYTES) throw new Error('DRAFT_TOO_LARGE');
  return bytes;
}

function deserialize(bytes: Uint8Array, options: DepositStorageOptions, operationId: string): LocalDraft {
  if (bytes.length > MAX_BYTES) throw new Error('DRAFT_TOO_LARGE');
  const draft = JSON.parse(decoder.decode(bytes), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && '__ecuDepositBigint' in value) {
      const raw = value.__ecuDepositBigint;
      if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('INVALID_DEPOSIT_DRAFT');
      return BigInt(raw);
    }
    return value;
  }) as LocalDraft;
  validate(draft, options);
  if (draft.operationId.toLowerCase() !== operationId.toLowerCase()) throw new Error('INVALID_DEPOSIT_DRAFT');
  return draft;
}

function stored(value: unknown): value is SealedDraft {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'ciphertext,nonce,version' &&
    (value as SealedDraft).version === 1 && Array.isArray((value as SealedDraft).nonce) &&
    (value as SealedDraft).nonce.length === 12 &&
    (value as SealedDraft).nonce.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
    Array.isArray((value as SealedDraft).ciphertext) &&
    (value as SealedDraft).ciphertext.length >= 16 && (value as SealedDraft).ciphertext.length <= MAX_BYTES + 16 &&
    (value as SealedDraft).ciphertext.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

async function seal(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>): Promise<SealedDraft> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: aad, tagLength: 128 }, key, plain));
  return { version: 1, nonce: [...nonce], ciphertext: [...ciphertext] };
}

async function openDraft(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  if (!stored(value)) throw new Error('INVALID_SEALED_DRAFT');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(value.nonce),
    additionalData: aad, tagLength: 128 }, key, new Uint8Array(value.ciphertext)));
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onblocked = () => { blocked = true; reject(new Error('DRAFT_STORAGE_BLOCKED')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function transact<T>(db: IDBDatabase, id: string, mode: 'readonly' | 'readwrite',
  decide: (value: unknown, store: IDBObjectStore) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = mode === 'readonly' ? db.transaction(STORE, mode) :
      db.transaction(STORE, mode, { durability: 'strict' });
    if (mode === 'readwrite' && tx.durability !== 'strict') {
      tx.abort(); reject(new Error('DRAFT_STRICT_DURABILITY_UNAVAILABLE')); return;
    }
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('DRAFT_TRANSACTION_ABORTED'));
    tx.onerror = () => reject(tx.error ?? new Error('DRAFT_TRANSACTION_FAILED'));
    const store = tx.objectStore(STORE);
    store.get(id).onsuccess = event => {
      try { result = decide((event.target as IDBRequest).result, store); }
      catch { try { tx.abort(); } catch { /* Already aborting. */ } }
    };
  });
}

/** Profile-local encrypted draft storage. A storage ACK proves persistence only: core
 * prepareSubmission must validate semantics and current history before send. Loss of
 * browser data loses the draft; this is not a server backup. */
export function createIndexedDbDepositStorage(options: DepositStorageOptions): StoragePort &
  { readDraft(operationId: string): Promise<DraftRead> } {
  const factory = options.factory === undefined ? globalThis.indexedDB : options.factory ?? undefined;
  return {
    async saveDraft(draft) {
      let db: IDBDatabase | undefined;
      try {
        validate(draft, options);
        const { id, aad } = identity(options, draft.operationId);
        const plain = serialize(draft);
        if (!factory) return 'unknown';
        db = await openDatabase(factory);
        const previous = await transact<unknown>(db, id, 'readonly', value => value);
        if (previous !== undefined) {
          const restored = await openDraft(options.key, aad, previous);
          deserialize(restored, options, draft.operationId);
          if (restored.length !== plain.length || restored.some((byte, i) => byte !== plain[i])) return 'unknown';
          return await transact(db, id, 'readwrite', value =>
            JSON.stringify(value) === JSON.stringify(previous) ? 'saved' as const : 'unknown' as const);
        }
        const encrypted = await seal(options.key, aad, plain);
        return await transact(db, id, 'readwrite', (value, store) => {
          if (value !== undefined) return 'unknown' as const;
          store.add(encrypted, id);
          return 'saved' as const;
        });
      } catch { return 'unknown'; }
      finally { db?.close(); }
    },
    async readDraft(operationId) {
      let db: IDBDatabase | undefined;
      try {
        const { id, aad } = identity(options, operationId);
        if (!factory) return { status: 'unknown' };
        db = await openDatabase(factory);
        const value = await transact<unknown>(db, id, 'readonly', found => found);
        if (value === undefined) return { status: 'absent' };
        const plain = await openDraft(options.key, aad, value);
        return { status: 'decrypted-unverified', draft: deserialize(plain, options, operationId) };
      } catch { return { status: 'unknown' }; }
      finally { db?.close(); }
    },
  };
}
