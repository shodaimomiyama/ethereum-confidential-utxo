import type { ReceivedUtxo } from '@confidential-utxo/core';
import type { RequestId, RewardRecord, RewardStatus, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import type { OperationContext, OperationResult } from './operations.js';
import { projectUnconfirmedSync } from './operations.js';
import { RewardRequestUncertain, type ScopedRewardClient } from './reward-client.js';

export interface RewardOperationDependencies {
  /** Read the current published state at the start of each serialized controller action. */
  readonly snapshot: () => ViewState;
  /** Construct a client captured to this action's scope and epoch. */
  readonly client: (context: OperationContext) => ScopedRewardClient;
  readonly newRequestId?: () => RequestId;
}

export interface RewardOperation {
  start(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<OperationResult>;
  recheck(scope: Scope, requestId: RequestId, context: OperationContext): Promise<OperationResult>;
  list(scope: Scope, context: OperationContext): Promise<OperationResult>;
  /** Only a successful core inspectReceipt result may be supplied here. */
  receive(scope: Scope, requestId: RequestId, receipt: ReceivedUtxo, context: OperationContext): Promise<OperationResult>;
}

const active = (status: RewardStatus): boolean => status !== 'received' && status !== 'ended-without-distribution';
const requestIdPattern = /^0x[0-9a-fA-F]{64}$/;

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
  for (const record of records) refs.set(record.requestId, {
    requestId: record.requestId, status: record.status, operationId: record.operationId,
  });
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
  return {
    async start(scope, input, context) {
      const { snapshot, client } = captured(scope, context);
      const existing = snapshot.rewardRequests.find(request => active(request.status));
      if (existing) return recheck(scope, existing.requestId, context);
      if (snapshot.isStale || snapshot.storageAvailability !== 'healthy') throw new Error('SERVICE_UNAVAILABLE');
      const amount = amountWei(input);
      const requestId = (deps.newRequestId ?? freshRequestId)();
      if (!requestIdPattern.test(requestId) || snapshot.rewardRequests.some(request => request.requestId.toLowerCase() === requestId.toLowerCase())) {
        throw new Error('INVALID_REQUEST_ID');
      }
      try {
        const record = await client.request(amount, requestId);
        check(scope, context, deps.snapshot());
        if (record.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
        return project(snapshot, scope, [record]);
      } catch (error) {
        if (!(error instanceof RewardRequestUncertain)) throw error;
        check(scope, context, deps.snapshot());
        if (error.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('SCOPE_CHANGED');
        const view = { ...snapshot, rewardRequests: [...snapshot.rewardRequests, { requestId, status: 'unknown' as const }],
          cards: { ...snapshot.cards, reward: { ...snapshot.cards.reward, phase: 'unknown' as const, reason: 'RESULT_UNKNOWN' as const } },
          allowedActions: [...new Set([...snapshot.allowedActions.filter(action => action !== 'start:reward'), 'recheck-reward'])],
          reasons: { ...snapshot.reasons, 'start:reward': 'RESULT_UNKNOWN' as const } };
        return { scope, view };
      }
    },
    recheck,
    async list(scope, context) {
      const { snapshot, client } = captured(scope, context);
      const records = await client.list();
      check(scope, context, deps.snapshot());
      return project(snapshot, scope, records);
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
