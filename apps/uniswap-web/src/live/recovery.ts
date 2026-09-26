import type { Address, ApiSuccessResponseMap, Bytes32, SavedOperation, Scope } from '@confidential-utxo/uniswap';
import { HttpFailure, sameScope, type HttpClient } from './http.js';
import { openRecord, type PlainRecord } from './record-crypto.js';
import type { CipherCache } from './cache.js';

/** Finalized evidence supplied by #29/#30. This port makes no spendability decision. */
export interface FinalizedOutput {
  readonly outputId: Bytes32;
  readonly operationId: Bytes32;
  readonly blockHash: Bytes32;
}
export interface FinalizedHistory { readonly outputs: readonly FinalizedOutput[] }
export interface ChainReader { readFinalized(scope: Scope): Promise<FinalizedHistory> }
export interface RecoveredRecord {
  readonly saved: SavedOperation & { readonly scope: Scope };
  readonly plaintext: PlainRecord;
}
export type RecoveryAvailability = 'healthy' | 'unavailable' | 'rollback' | 'unknown';
export interface RecoveryResult {
  readonly records: readonly RecoveredRecord[];
  readonly finalized: FinalizedHistory;
  readonly availability: RecoveryAvailability;
  /** Eligibility only; #55 still decides each operation and spendable output. */
  readonly allowedActions: readonly string[];
}
const emptyHistory: FinalizedHistory = { outputs: [] };
const hex32 = /^0x[0-9a-fA-F]{64}$/;
function blocked(availability: Exclude<RecoveryAvailability, 'healthy'>): RecoveryResult {
  return { records: [], finalized: emptyHistory, availability, allowedActions: [] };
}
function deduplicate(history: FinalizedHistory): FinalizedHistory {
  const outputs = new Map<string, FinalizedOutput>();
  for (const output of history.outputs) {
    if (!hex32.test(output.outputId) || !hex32.test(output.operationId) || !hex32.test(output.blockHash)) throw new Error('INVALID_CHAIN_HISTORY');
    const id = output.outputId.toLowerCase();
    const old = outputs.get(id);
    if (old && (old.operationId.toLowerCase() !== output.operationId.toLowerCase()
      || old.blockHash.toLowerCase() !== output.blockHash.toLowerCase())) throw new Error('CONFLICTING_CHAIN_HISTORY');
    if (!old) outputs.set(id, output);
  }
  return { outputs: [...outputs.values()] };
}

export class Recovery {
  constructor(private readonly deps: { readonly http: HttpClient; readonly chain: ChainReader;
    readonly cache?: CipherCache; readonly chainId: bigint; readonly pool: Address }) {}

  /** Call only after the user's explicit authentication action has established a session. */
  async load(scope: Scope, key: CryptoKey): Promise<RecoveryResult> {
    let listed: ApiSuccessResponseMap['GET /v1/operations'];
    try { listed = await this.deps.http.call('GET /v1/operations', { scope }); }
    catch (error) {
      return blocked(error instanceof HttpFailure && (error.kind === 'network' || error.code === 'SERVICE_UNAVAILABLE')
        ? 'unavailable' : 'unknown');
    }
    if (listed.availability === 'rollback') return blocked('rollback');
    if (listed.availability !== 'healthy') return blocked('unknown');
    try {
      const seen = new Set<string>();
      const records: RecoveredRecord[] = [];
      for (const saved of listed.records) {
        if (!sameScope(saved.scope, scope) || !sameScope(saved.record.scope, scope)
          || !Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error('INVALID_SAVED_RECORD');
        const id = saved.record.recordId.toLowerCase();
        if (seen.has(id)) throw new Error('DUPLICATE_SAVED_RECORD');
        seen.add(id);
        const plaintext = await openRecord(key, { deploymentId: scope.deploymentId,
          chainId: this.deps.chainId, pool: this.deps.pool, owner: scope.owner,
          recordId: saved.record.recordId, revision: saved.revision }, saved.record.encryptedBundle);
        if (plaintext.operationId.toLowerCase() !== saved.record.operationId.toLowerCase()
          || (saved.record.kind === 'pay'
            ? plaintext.paymentId?.toLowerCase() !== saved.record.paymentId.toLowerCase()
            : plaintext.paymentId !== undefined)) {
          throw new Error('RECORD_INDEX_MISMATCH');
        }
        records.push({ saved, plaintext });
      }
      const finalized = deduplicate(await this.deps.chain.readFinalized(scope));
      // Cache writes are hints only. Failure cannot turn verified server/chain state into failure.
      for (const { saved } of records) {
        const cache = this.deps.cache;
        if (cache) {
          void Promise.resolve().then(() => cache.write(scope, saved.record.recordId, {
            recordId: saved.record.recordId, revision: saved.revision,
            encryptedBundle: saved.record.encryptedBundle, updatedAt: Date.now(),
          })).catch(() => { /* Optional cache. */ });
        }
      }
      return { records, finalized, availability: 'healthy', allowedActions: ['new-authorization-eligible'] };
    } catch { return blocked('unknown'); }
  }
}
