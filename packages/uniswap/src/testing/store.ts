import type { Bytes32, RequestId, Scope } from '../domain.js';
import type {
  OperationRecord, OperationStore, RewardRecord, RewardRequest,
  RewardStore, SavedOperation,
} from '../storage.js';
import { StoreError } from '../storage.js';

export interface StoreSeed {
  readonly operations?: readonly SavedOperation[];
  readonly rewards?: readonly RewardRecord[];
}

export interface StoreJournalEntry {
  readonly kind: 'operation-put' | 'reward-create' | 'reward-received';
  readonly scope: Scope;
  readonly id: string;
}

export interface StoreControl {
  reset(seed?: StoreSeed): void;
  setUnavailable(value: boolean): void;
  simulateRollback(mode?: 'flag' | 'partial'): void;
  loseNextAck(route: string): void;
  consumeLostAck(route: string): boolean;
  setRewardFinalized(scope: Scope, requestId: RequestId, outputId: Bytes32, blockHash: Bytes32): void;
  journal(): readonly StoreJournalEntry[];
  health(): 'healthy' | 'unavailable' | 'rollback';
}

export interface MemoryStore {
  readonly operations: OperationStore;
  readonly rewards: RewardStore;
  availability(): 'healthy' | 'unavailable' | 'rollback';
  readonly control: StoreControl;
}

function scopeKey(scope: Scope): string {
  return `${scope.deploymentId}\u0000${scope.owner.toLowerCase()}`;
}

function operationKey(record: OperationRecord): string {
  return `${scopeKey(record.scope)}\u0000${record.inputId.toLowerCase()}`;
}

function rewardKey(scope: Scope, requestId: RequestId): string {
  return `${scopeKey(scope)}\u0000${requestId.toLowerCase()}`;
}

function sameRecord(a: OperationRecord, b: OperationRecord): boolean {
  return a.kind === b.kind
    && a.recordId.toLowerCase() === b.recordId.toLowerCase()
    && a.contentHash.toLowerCase() === b.contentHash.toLowerCase()
    && a.operationId.toLowerCase() === b.operationId.toLowerCase()
    && a.signatureStarted === b.signatureStarted
    && a.encryptedBundle.ciphertext === b.encryptedBundle.ciphertext
    && a.encryptedBundle.nonce === b.encryptedBundle.nonce
    && a.encryptedBundle.tag === b.encryptedBundle.tag
    && a.attemptIds.join(',') === b.attemptIds.join(',')
    && (a.kind !== 'pay' || (b.kind === 'pay'
      && a.paymentId.toLowerCase() === b.paymentId.toLowerCase()
      && a.deadline === b.deadline));
}

function sameReward(a: RewardRecord, b: RewardRequest): boolean {
  return a.amountWei === b.amountWei
    && a.recipientInfo.owner.toLowerCase() === b.recipientInfo.owner.toLowerCase()
    && a.recipientInfo.publicKey.toLowerCase() === b.recipientInfo.publicKey.toLowerCase()
    && a.recipientInfo.signature.toLowerCase() === b.recipientInfo.signature.toLowerCase();
}

export function createMemoryStore(seed: StoreSeed = {}): MemoryStore {
  const operations = new Map<string, SavedOperation>();
  const rewards = new Map<string, RewardRecord>();
  const lostAcks = new Map<string, number>();
  const entries: StoreJournalEntry[] = [];
  let health: 'healthy' | 'unavailable' | 'rollback' = 'healthy';

  function reset(next: StoreSeed = {}): void {
    operations.clear();
    rewards.clear();
    lostAcks.clear();
    entries.length = 0;
    health = 'healthy';
    for (const saved of next.operations ?? []) operations.set(operationKey(saved.record), structuredClone(saved));
    for (const reward of next.rewards ?? []) rewards.set(rewardKey(reward.scope, reward.requestId), structuredClone(reward));
  }

  function readable(): void {
    if (health === 'unavailable') throw new StoreError('UNAVAILABLE');
  }

  function writable(): void {
    if (health !== 'healthy') throw new StoreError('UNAVAILABLE');
  }

  reset(seed);
  return {
    availability: () => health,
    operations: {
      put(record, expectedRevision) {
        writable();
        const key = operationKey(record);
        const existing = operations.get(key);
        if (existing === undefined && [...operations.values()].some(({ record: saved }) =>
          scopeKey(saved.scope) === scopeKey(record.scope)
          && saved.recordId.toLowerCase() === record.recordId.toLowerCase())) {
          throw new StoreError('CONFLICT');
        }
        if (existing !== undefined) {
          if (existing.record.recordId.toLowerCase() !== record.recordId.toLowerCase()
            || existing.record.contentHash.toLowerCase() !== record.contentHash.toLowerCase()
            || existing.record.kind !== record.kind
            || existing.record.operationId.toLowerCase() !== record.operationId.toLowerCase()
            || (existing.record.kind === 'pay' && record.kind === 'pay'
              && (existing.record.paymentId.toLowerCase() !== record.paymentId.toLowerCase()
                || existing.record.deadline !== record.deadline))) {
            throw new StoreError('CONFLICT');
          }
          if ((existing.record.signatureStarted && !record.signatureStarted)
            || existing.record.attemptIds.some((id, index) => record.attemptIds[index] !== id)) {
            throw new StoreError('CONFLICT');
          }
          if (sameRecord(existing.record, record)) return structuredClone(existing);
          if (expectedRevision !== existing.revision) throw new StoreError('REVISION_CONFLICT');
          const updated = { record: structuredClone(record), revision: existing.revision + 1 };
          operations.set(key, updated);
          entries.push({ kind: 'operation-put', scope: record.scope, id: record.recordId });
          return structuredClone(updated);
        }
        if (expectedRevision !== 0) throw new StoreError('REVISION_CONFLICT');
        const saved = { record: structuredClone(record), revision: 1 };
        operations.set(key, saved);
        entries.push({ kind: 'operation-put', scope: record.scope, id: record.recordId });
        return structuredClone(saved);
      },
      list(scope) {
        readable();
        return [...operations.values()]
          .filter(({ record }) => scopeKey(record.scope) === scopeKey(scope))
          .map((saved) => structuredClone(saved));
      },
      get(scope, recordId) {
        readable();
        const saved = [...operations.values()].find(({ record }) =>
          scopeKey(record.scope) === scopeKey(scope)
          && record.recordId.toLowerCase() === recordId.toLowerCase());
        return saved === undefined ? undefined : structuredClone(saved);
      },
    },
    rewards: {
      create(request) {
        writable();
        const key = rewardKey(request.scope, request.requestId);
        const existing = rewards.get(key);
        if (existing !== undefined) {
          if (!sameReward(existing, request)) throw new StoreError('CONFLICT');
          return structuredClone(existing);
        }
        const pending = [...rewards.values()].find((reward) =>
          scopeKey(reward.scope) === scopeKey(request.scope)
          && reward.status !== 'received'
          && reward.status !== 'ended-without-distribution');
        if (pending !== undefined) throw new StoreError('PENDING_REQUEST');
        const created: RewardRecord = {
          ...structuredClone(request), status: 'accepted', attemptIds: [], txHashes: [],
        };
        rewards.set(key, created);
        entries.push({ kind: 'reward-create', scope: request.scope, id: request.requestId });
        return structuredClone(created);
      },
      list(scope) {
        readable();
        return [...rewards.values()]
          .filter((reward) => scopeKey(reward.scope) === scopeKey(scope))
          .map((reward) => structuredClone(reward));
      },
      get(scope, requestId) {
        readable();
        const reward = rewards.get(rewardKey(scope, requestId));
        return reward === undefined ? undefined : structuredClone(reward);
      },
      markReceived(scope, requestId, outputId, blockHash) {
        readable();
        const key = rewardKey(scope, requestId);
        const existing = rewards.get(key);
        if (existing === undefined) throw new StoreError('NOT_FOUND');
        if (existing.status === 'received'
          && existing.outputId === outputId && existing.blockHash === blockHash) {
          return structuredClone(existing);
        }
        if (existing.status !== 'finalized'
          || existing.outputId !== outputId || existing.blockHash !== blockHash) {
          throw new StoreError('NOT_FINALIZED');
        }
        const updated: RewardRecord = { ...existing, status: 'received' };
        rewards.set(key, updated);
        entries.push({ kind: 'reward-received', scope, id: requestId });
        return structuredClone(updated);
      },
    },
    control: {
      reset,
      setUnavailable(value) { health = value ? 'unavailable' : 'healthy'; },
      simulateRollback(mode = 'flag') {
        health = 'rollback';
        if (mode === 'partial') {
          const mostRecentKey = [...operations.keys()].at(-1);
          if (mostRecentKey !== undefined) operations.delete(mostRecentKey);
        }
      },
      loseNextAck(route) { lostAcks.set(route, (lostAcks.get(route) ?? 0) + 1); },
      consumeLostAck(route) {
        const count = lostAcks.get(route) ?? 0;
        if (count === 0) return false;
        lostAcks.set(route, count - 1);
        return true;
      },
      setRewardFinalized(scope, requestId, outputId, blockHash) {
        writable();
        const key = rewardKey(scope, requestId);
        const existing = rewards.get(key);
        if (existing === undefined) throw new StoreError('NOT_FOUND');
        rewards.set(key, { ...existing, status: 'finalized', outputId, blockHash });
      },
      journal: () => structuredClone(entries),
      health: () => health,
    },
  };
}
