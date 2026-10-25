import type { ReceivedUtxo } from '@confidential-utxo/core';
import type { OperationRef, RequestId, RewardRecord, RewardStatus, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../contracts/index.js';
import { HttpFailure, sameScope } from './http.js';
import type { OperationContext, OperationResult } from './operations.js';
import { projectUnconfirmedSync } from './operations.js';
import { RewardRequestUncertain, type ScopedRewardClient } from './reward-client.js';

export interface RewardOperationDependencies {
  /** Read the current published state at the start of each serialized controller action. */
  readonly snapshot: () => ViewState;
  /** Construct a client captured to this action's scope and epoch. */
  readonly client: (context: OperationContext) => ScopedRewardClient;
  /** Atomic durable public-ID reservation. `saved` means the write was ACKed before POST. */
  readonly marker: RewardRequestMarker;
  readonly newRequestId?: () => RequestId;
}

export interface RewardRequestMarker {
  /** Strongly consistent read; return `unknown` unless absence is proven. */
  read(scope: Scope): Promise<{ readonly kind: 'absent' } | { readonly kind: 'saved'; readonly requestId: RequestId } | { readonly kind: 'unknown' }>;
  /** Atomic insert-if-absent; `saved` requires a durable ACK. */
  reserve(scope: Scope, requestId: RequestId): Promise<'saved' | 'occupied' | 'unknown'>;
  /** Atomic compare-and-swap. Clear only after terminal GET or a proven pre-admission failure. */
  replace(scope: Scope, expected: RequestId, next: RequestId | undefined): Promise<'saved' | 'mismatch' | 'unknown'>;
}

export interface RewardOperation {
  start(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<OperationResult>;
  recheck(scope: Scope, requestId: RequestId, context: OperationContext): Promise<OperationResult>;
  list(scope: Scope, context: OperationContext): Promise<OperationResult>;
  listFrom(scope: Scope, view: ViewState, context: OperationContext): Promise<OperationResult>;
  /** Only a successful core inspectReceipt result may be supplied here. */
  receive(scope: Scope, requestId: RequestId, receipt: ReceivedUtxo, context: OperationContext): Promise<OperationResult>;
}

const active = (status: RewardStatus): boolean => status !== 'received' && status !== 'ended-without-distribution';
const requestIdPattern = /^0x[0-9a-fA-F]{64}$/;
const rejectedBeforeAdmission = new Set(['INVALID_REQUEST', 'UNAUTHENTICATED', 'SCOPE_MISMATCH', 'PAYLOAD_TOO_LARGE']);

function mayClearAfterRequestFailure(error: unknown): boolean {
  if (error instanceof RewardRequestUncertain) return false;
  if (error instanceof HttpFailure) return error.kind === 'api' && error.code !== undefined && rejectedBeforeAdmission.has(error.code);
  // ScopedRewardClient wraps every uncertain POST/response failure. Its remaining
  // unwrapped exceptions arise before the POST, including a refused signature.
  return true;
}

function freshRequestId(): RequestId {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}` as RequestId;
}

function amountWei(input: Readonly<Record<string, string>>): string {
  const value = input.amount;
  if (value === undefined || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error('INVALID_DECIMAL');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (amount <= 0n || amount >= (1n << 256n)) throw new Error('INVALID_DECIMAL');
  return amount.toString();
}

function phase(status: RewardStatus): ViewState['cards']['reward']['phase'] {
  switch (status) {
    case 'accepted':
    case 'queued':
    case 'processing':
    case 'pending': return 'pending';
    case 'finalized': return 'confirmed-receipt-pending';
    case 'received': return 'complete';
    case 'ended-without-distribution': return 'failed';
    case 'unknown': return 'unknown';
  }
}

function check(scope: Scope, context: OperationContext, snapshot: ViewState): void {
  context.check();
  if (!sameScope(scope, context.scope) || !sameScope(scope, snapshot.scope)) throw new Error('SCOPE_CHANGED');
}

function project(snapshot: ViewState, scope: Scope, records: readonly RewardRecord[]): OperationResult {
  if (records.some(record => !sameScope(record.scope, scope))) throw new Error('SCOPE_CHANGED');
  // A missing list entry cannot prove an uncertain POST was never accepted.
  const refs = new Map(snapshot.rewardRequests.map(item => [item.requestId, item]));
  const operations = new Map(snapshot.operations.map(item => [item.operationId.toLowerCase(), item]));
  const operationCards = { ...snapshot.operationCards };
  const operationActions = { ...snapshot.operationActions };
  for (const record of records) refs.set(record.requestId, {
    requestId: record.requestId, status: record.status, operationId: record.operationId,
  });
  for (const record of records) {
    if (!record.operationId) continue;
    const id = record.operationId.toLowerCase();
    if (operationCards[record.operationId] && operationCards[record.operationId] !== 'reward') throw new Error('OPERATION_CARD_MISMATCH');
    const prior = operations.get(id);
    if (prior && !sameScope(prior.scope, scope)) throw new Error('SCOPE_CHANGED');
    const reference: OperationRef = prior ?? { scope, operationId: record.operationId,
      attemptIds: record.attemptIds, txHashes: record.txHashes,
      chainOutcome: 'unknown', receiptState: 'none' };
    operations.set(id, reference);
    operationCards[record.operationId] = 'reward';
    operationActions[record.operationId] ??= ['recheck'];
  }
  const requests = [...refs.values()];
  const latest = requests.at(-1);
  const nextPhase = latest ? phase(latest.status) : snapshot.cards.reward.phase;
  const allowed = new Set(snapshot.allowedActions);
  const reasons = { ...snapshot.reasons };
  if (requests.some(request => active(request.status))) allowed.add('recheck-reward');
  else allowed.delete('recheck-reward');
  if (latest && active(latest.status)) {
    allowed.delete('start:reward');
    reasons['start:reward'] = latest.status === 'unknown' ? 'RESULT_UNKNOWN' : 'REWARD_PENDING';
  } else if (latest?.status === 'received' && snapshot.storageAvailability === 'healthy' && !snapshot.isStale) {
    allowed.add('start:reward');
    delete reasons['start:reward'];
  }
  const view: ViewState = { ...snapshot, rewardRequests: requests,
    operations: [...operations.values()], operationCards, operationActions,
    cards: { ...snapshot.cards, reward: { ...snapshot.cards.reward, phase: nextPhase,
      reason: latest?.status === 'unknown' ? 'RESULT_UNKNOWN' : undefined } },
    allowedActions: [...allowed], reasons };
  return { scope, view: snapshot.isStale || snapshot.storageAvailability !== 'healthy'
    ? projectUnconfirmedSync(view, snapshot.storageAvailability) : view };
}

/** A bounded reward card adapter; it does not claim receipt or update spendable balance. */
export function createRewardOperation(deps: RewardOperationDependencies): RewardOperation {
  function captured(scope: Scope, context: OperationContext): { snapshot: ViewState; client: ScopedRewardClient } {
    const snapshot = deps.snapshot();
    check(scope, context, snapshot);
    return { snapshot, client: deps.client(context) };
  }
  async function recheck(scope: Scope, requestId: RequestId, context: OperationContext): Promise<OperationResult> {
    const { snapshot, client } = captured(scope, context);
    if (!snapshot.rewardRequests.some(request => request.requestId.toLowerCase() === requestId.toLowerCase())) throw new Error('NOT_ALLOWED');
    const record = await client.recheck(requestId);
    check(scope, context, deps.snapshot());
    if (record.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
    return project(snapshot, scope, [record]);
  }
  async function recheckDiscovered(snapshot: ViewState, client: ScopedRewardClient, scope: Scope,
    requestId: RequestId, context: OperationContext): Promise<OperationResult> {
    const record = await client.recheck(requestId);
    check(scope, context, deps.snapshot());
    if (record.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
    return project(snapshot, scope, [record]);
  }
  async function reserveDiscovered(scope: Scope, requestId: RequestId, context: OperationContext): Promise<void> {
    if (!requestIdPattern.test(requestId)) throw new Error('RESULT_UNKNOWN');
    const ack = await deps.marker.reserve(scope, requestId);
    check(scope, context, deps.snapshot());
    if (ack !== 'saved') throw new Error('RESULT_UNKNOWN');
  }
  return {
    async start(scope, input, context) {
      const { snapshot, client } = captured(scope, context);
      if (snapshot.isStale || snapshot.storageAvailability !== 'healthy') throw new Error('SERVICE_UNAVAILABLE');
      const marker = await deps.marker.read(scope);
      check(scope, context, deps.snapshot());
      if (marker.kind === 'unknown') throw new Error('RESULT_UNKNOWN');
      if (marker.kind === 'saved' && !requestIdPattern.test(marker.requestId)) throw new Error('RESULT_UNKNOWN');
      // The service is queried before any new ID is allocated, including on a fresh tab.
      const listed = await client.list();
      check(scope, context, deps.snapshot());
      if (listed.some(record => !sameScope(record.scope, scope))) throw new Error('SCOPE_CHANGED');
      let base = snapshot;
      if (marker.kind === 'saved') {
        // GET remains mandatory even when the list omits this ID. A missing GET fails closed.
        const current = await recheckDiscovered(snapshot, client, scope, marker.requestId, context);
        const saved = current.view.rewardRequests.find(item => item.requestId.toLowerCase() === marker.requestId.toLowerCase());
        if (!saved || active(saved.status)) return current;
        const other = listed.find(record => record.requestId.toLowerCase() !== marker.requestId.toLowerCase() && active(record.status))
          ?? snapshot.rewardRequests.find(request => request.requestId.toLowerCase() !== marker.requestId.toLowerCase() && active(request.status));
        if (other) {
          const found = await recheckDiscovered(current.view, client, scope, other.requestId, context);
          const adopted = await deps.marker.replace(scope, marker.requestId, other.requestId);
          check(scope, context, deps.snapshot());
          if (adopted !== 'saved') throw new Error('RESULT_UNKNOWN');
          return found;
        }
        const cleared = await deps.marker.replace(scope, marker.requestId, undefined);
        check(scope, context, deps.snapshot());
        if (cleared !== 'saved') throw new Error('RESULT_UNKNOWN');
        base = current.view;
        const afterClear = await client.list();
        check(scope, context, deps.snapshot());
        if (afterClear.some(record => !sameScope(record.scope, scope))) throw new Error('SCOPE_CHANGED');
        const concurrent = afterClear.find(record => active(record.status));
        if (concurrent) {
          await reserveDiscovered(scope, concurrent.requestId, context);
          return recheckDiscovered(base, client, scope, concurrent.requestId, context);
        }
      } else {
        const existing = listed.find(record => active(record.status))
          ?? snapshot.rewardRequests.find(request => active(request.status));
        if (existing) {
          await reserveDiscovered(scope, existing.requestId, context);
          return recheckDiscovered(snapshot, client, scope, existing.requestId, context);
        }
      }
      const amount = amountWei(input);
      const requestId = (deps.newRequestId ?? freshRequestId)();
      if (!requestIdPattern.test(requestId) || base.rewardRequests.some(request => request.requestId.toLowerCase() === requestId.toLowerCase())) {
        throw new Error('INVALID_REQUEST_ID');
      }
      const reserved = await deps.marker.reserve(scope, requestId);
      check(scope, context, deps.snapshot());
      if (reserved !== 'saved') throw new Error('RESULT_UNKNOWN');
      let record: RewardRecord;
      try {
        record = await client.request(amount, requestId);
      } catch (error) {
        if (error instanceof HttpFailure && error.kind === 'api' && error.code === 'PENDING_REQUEST') {
          const pending = await client.list();
          check(scope, context, deps.snapshot());
          if (pending.some(record => !sameScope(record.scope, scope))) throw new Error('SCOPE_CHANGED');
          const prior = pending.find(record => active(record.status));
          if (!prior) throw new Error('RESULT_UNKNOWN');
          const found = await recheckDiscovered(base, client, scope, prior.requestId, context);
          const adopted = await deps.marker.replace(scope, requestId, prior.requestId);
          check(scope, context, deps.snapshot());
          if (adopted !== 'saved') throw new Error('RESULT_UNKNOWN');
          return found;
        }
        if (mayClearAfterRequestFailure(error)) {
          check(scope, context, deps.snapshot());
          const cleared = await deps.marker.replace(scope, requestId, undefined);
          check(scope, context, deps.snapshot());
          if (cleared !== 'saved') throw new Error('RESULT_UNKNOWN');
          throw error;
        }
        if (!(error instanceof RewardRequestUncertain)) throw error;
        check(scope, context, deps.snapshot());
        if (error.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
        const view = { ...base, rewardRequests: [...base.rewardRequests, { requestId, status: 'unknown' as const }],
          cards: { ...base.cards, reward: { ...base.cards.reward, phase: 'unknown' as const, reason: 'RESULT_UNKNOWN' as const } },
          allowedActions: [...new Set([...base.allowedActions.filter(action => action !== 'start:reward'), 'recheck-reward'])],
          reasons: { ...base.reasons, 'start:reward': 'RESULT_UNKNOWN' as const } };
        return { scope, view };
      }
      check(scope, context, deps.snapshot());
      if (record.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
      return project(base, scope, [record]);
    },
    recheck,
    async list(scope, context) {
      const { snapshot, client } = captured(scope, context);
      const records = await client.list();
      check(scope, context, deps.snapshot());
      return project(snapshot, scope, records);
    },
    async listFrom(scope, view, context) {
      check(scope, context, view);
      const records = await deps.client(context).list();
      check(scope, context, deps.snapshot());
      return project(view, scope, records);
    },
    async receive(scope, requestId, receipt, context) {
      const { snapshot, client } = captured(scope, context);
      if (!snapshot.rewardRequests.some(request => request.requestId.toLowerCase() === requestId.toLowerCase())) throw new Error('NOT_ALLOWED');
      const record = await client.markReceived(requestId, receipt);
      check(scope, context, deps.snapshot());
      if (record.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
      return project(snapshot, scope, [record]);
    },
  };
}
