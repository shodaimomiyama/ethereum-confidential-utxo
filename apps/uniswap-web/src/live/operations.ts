import type { OperationId, OperationRef, RequestId, Scope } from '@confidential-utxo/uniswap';
import type { Card, CardPhase, UiAction, ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import type { KeySession } from './key-session.js';
import type { RecoveryResult } from './recovery.js';
import type { WalletEvent, WalletPort } from './wallet.js';
import type { CryptoJob, CryptoPayloads, CryptoResult, CryptoValues } from './worker-protocol.js';

/** A captured action context. Adapters must check it after their own asynchronous work. */
export interface OperationContext {
  readonly scope: Scope;
  readonly epoch: number;
  check(): void;
  typedSign: WalletPort['typedSign'];
  sendTransaction: WalletPort['sendTransaction'];
  runCrypto(job: { [K in CryptoJob['kind']]: Omit<Extract<CryptoJob, { kind: K }>, 'scope' | 'epoch'> }[CryptoJob['kind']]): Promise<CryptoResult>;
  recordKey: KeySession['recordKey'];
  recipientInfo: KeySession['recipientInfo'];
  recipientPrivateKeyForWorker: KeySession['recipientPrivateKeyForWorker'];
}

/** The handle stays inside the adapter; it must never be copied into ViewState. */
export interface PreparedOperation {
  readonly scope: Scope;
  readonly card: 'pay' | 'deposit' | 'withdraw';
  readonly operationId: OperationId;
  readonly handle: unknown;
  readonly proof?: { readonly jobId: string; readonly payload: CryptoPayloads['prove'] };
}

/** The published adapter owns validation, actions, selection and balance decisions. */
export interface OperationResult {
  readonly scope: Scope;
  readonly view: ViewState;
  readonly operation?: OperationRef;
  readonly card?: Card;
}
export type ReceiptResult = OperationResult;
export type SyncResult = OperationResult;
export type PreparationResult =
  | { readonly kind: 'prepared'; readonly prepared: PreparedOperation }
  | { readonly kind: 'decision'; readonly result: OperationResult };
export type TransitionAction = Exclude<UiAction, { readonly type: 'switch-scope' }>;

/**
 * Integration boundary for #55/#29/#30 and the reward service. This is not a
 * replacement PaymentClient. In particular authorize must delegate to #55's
 * durable reserve → signatureStarted ACK → sign → save signatures/attempt → submit
 * sequence. Its wallet callbacks must use the captured context, never a raw wallet.
 * Real bindings remain required before this port can be used with live assets.
 */
export interface OperationPort {
  connectionChanged(previous: ViewState, connection: WalletEvent): ViewState;
  switchScope(previous: ViewState, scope: Scope): ViewState;
  transition(scope: Scope, action: TransitionAction, previous: ViewState, context: OperationContext): Promise<OperationResult>;
  preparePay(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<PreparedOperation>;
  prepareDeposit(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<PreparedOperation>;
  prepareWithdraw(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<PreparedOperation>;
  /** Bind the Worker proof and revalidate published terms; stale terms return a decision requiring confirmation. */
  completePreparation(prepared: PreparedOperation, proof: CryptoValues['prove'] | undefined, context: OperationContext): Promise<PreparationResult>;
  authorize(prepared: PreparedOperation, context: OperationContext): Promise<OperationResult>;
  syncFinalized(scope: Scope, context: OperationContext, recovered?: RecoveryResult): Promise<SyncResult>;
  startReward(scope: Scope, input: Readonly<Record<string, string>>, context: OperationContext): Promise<OperationResult>;
  recheckReward(scope: Scope, requestId: RequestId, context: OperationContext): Promise<OperationResult>;
  recheck(scope: Scope, operationId: OperationId, context: OperationContext): Promise<OperationResult>;
  resumeOriginal(scope: Scope, operationId: OperationId, context: OperationContext): Promise<OperationResult>;
  retryAttempt(scope: Scope, operationId: OperationId, context: OperationContext): Promise<OperationResult>;
  receive(scope: Scope, operationId: OperationId, context: OperationContext): Promise<ReceiptResult>;
  /** Preserve reservations/IDs on refusal, Worker failure, lost ACK and unknown outcome. No automatic release or retry. */
  failure(scope: Scope, action: UiAction, previous: ViewState, error: unknown): OperationResult;
}

const cards = ['reward', 'pay', 'deposit', 'withdraw'] as const;
const safeWhileStale = (action: string): boolean => action === 'switch-scope' || action === 'resync'
  || action === 'connect' || action === 'connect-wallet' || action === 'switch-network'
  || action === 'prepare-key' || action === 'authenticate'
  || action.startsWith('edit:') || action.startsWith('new-operation:')
  || action === 'recheck' || action === 'recheck-reward';

/** Keep the last scoped display, but withdraw every action that could use stale spendability. */
export function projectUnconfirmedSync(previous: ViewState, availability: ViewState['storageAvailability'] = previous.storageAvailability): ViewState {
  const reason = availability === 'healthy' ? 'RESULT_UNKNOWN' : 'SERVICE_UNAVAILABLE';
  return { ...previous, isStale: true, storageAvailability: availability,
    preparation: previous.preparation,
    selectedInput: {},
    utxos: previous.utxos.map(utxo => ({ ...utxo, available: false })),
    operations: previous.operations.map(operation => ({ ...operation,
      chainOutcome: operation.chainOutcome === 'finalized-success' || operation.chainOutcome === 'finalized-failure'
        ? 'unknown' as const : operation.chainOutcome })),
    rewardRequests: previous.rewardRequests.map(request => ({ ...request,
      status: ['finalized', 'received', 'ended-without-distribution'].includes(request.status)
        ? 'unknown' as const : request.status })),
    cards: Object.fromEntries(cards.map(card => {
      const current = previous.cards[card];
      const settled = ['complete', 'failed', 'confirmed-receipt-pending', 'receipt-invalid'].includes(current.phase);
      return [card, settled ? { ...current, phase: 'unknown', reason: 'RESULT_UNKNOWN', approvalPurpose: undefined } : current];
    })) as ViewState['cards'],
    allowedActions: [...new Set([...previous.allowedActions.filter(safeWhileStale),
      ...(previous.rewardRequests.length > 0 ? ['recheck-reward'] : [])])],
    operationActions: Object.fromEntries(previous.operations.map(operation => [operation.operationId, ['recheck']])),
    reasons: { ...previous.reasons, ...Object.fromEntries(cards.map(card => [`start:${card}`, reason])) },
  };
}

function clearScopedData(previous: ViewState, scope: Scope): ViewState {
  return { ...previous, scope, connection: 'disconnected', currentScope: undefined,
    preparation: { wallet: false, network: false, key: false, authenticated: false, faucet: false, gas: false },
    utxos: [], selectedInput: {}, operationCards: {}, operationActions: {},
    publicEthWei: 0n, availablePrivateWei: 0n, pendingPrivateWei: 0n, checkedAt: undefined,
    isStale: true, cards: Object.fromEntries(cards.map(card => [card, { phase: 'needs-preparation', input: {} }])) as ViewState['cards'],
    operations: [], rewardRequests: [], allowedActions: ['switch-scope', 'connect'], reasons: {},
  };
}

/** A new scope cannot inherit balances, drafts, operation IDs or reward requests. */
export function projectScopeChange(previous: ViewState, scope: Scope): ViewState {
  return sameScope(previous.scope, scope) ? projectUnconfirmedSync(previous) : clearScopedData(previous, scope);
}

/** Wallet events invalidate key material and all previously calculated spending choices. */
export function projectConnectionChange(previous: ViewState, connection: WalletEvent): ViewState {
  if (connection.wrongNetworkScope) {
    const cleared = clearScopedData(previous, connection.wrongNetworkScope);
    return { ...cleared, connection: 'connected', currentScope: connection.wrongNetworkScope,
      preparation: { ...cleared.preparation, wallet: true, network: false },
      allowedActions: ['switch-scope', 'connect', 'switch-network'] };
  }
  const same = connection.scope !== undefined && sameScope(previous.scope, connection.scope);
  if (!same) {
    const cleared = clearScopedData(previous, connection.scope ?? previous.scope);
    return connection.scope === undefined ? cleared : { ...cleared, connection: 'connected',
      currentScope: connection.scope, preparation: { ...cleared.preparation, wallet: true, network: true },
      allowedActions: [...cleared.allowedActions, 'prepare-key'] };
  }
  const stale = projectUnconfirmedSync(previous);
  return { ...stale, connection: 'connected', currentScope: previous.scope,
    preparation: { ...stale.preparation, wallet: true, network: true, key: false, authenticated: false },
    allowedActions: [...new Set([...stale.allowedActions, 'prepare-key'])],
  };
}

/** A draft edit requires a fresh adapter decision before it becomes spendable. */
export function projectDraft(previous: ViewState, action: Extract<UiAction, { type: 'edit' | 'new-operation' }>): ViewState {
  const current = previous.cards[action.card];
  const input = action.type === 'edit' ? { ...current.input, [action.field]: action.value } : {};
  const next = { ...current, input, phase: 'invalid-input' as const, reason: 'INPUT_INVALID' as const,
    approvalPurpose: undefined, quote: undefined, proposedQuote: undefined };
  return { ...previous, cards: { ...previous.cards, [action.card]: next },
    selectedInput: { ...previous.selectedInput, [action.card]: undefined },
    allowedActions: previous.allowedActions.filter(key => key !== `start:${action.card}` && key !== 'confirm-terms'),
    reasons: { ...previous.reasons, [`start:${action.card}`]: 'INPUT_INVALID' },
  };
}

function phaseOf(operation: OperationRef, current: CardPhase): CardPhase {
  if (operation.chainOutcome === 'unknown') return 'unknown';
  if (operation.chainOutcome === 'pending') return 'pending';
  if (operation.chainOutcome === 'finalized-failure') return 'failed';
  if (operation.chainOutcome !== 'finalized-success') return current;
  if (operation.receiptState === 'invalid') return 'receipt-invalid';
  if (operation.receiptState === 'pending') return 'confirmed-receipt-pending';
  if (operation.receiptState === 'confirmed' || operation.receiptState === 'none') return 'complete';
  return current;
}

export function mapDecisionToView(previous: ViewState, result: OperationResult): ViewState {
  const { view, operation, card } = result;
  if (!sameScope(previous.scope, result.scope) || !sameScope(view.scope, result.scope)
    || view.operations.some(item => !sameScope(item.scope, result.scope))
    || (operation && !sameScope(operation.scope, result.scope))) throw new Error('SCOPE_CHANGED');
  if (view.isStale === true || (view.storageAvailability !== undefined && view.storageAvailability !== 'healthy')) {
    const operations = new Map(previous.operations.map(item => [item.operationId, item]));
    for (const item of view.operations) operations.set(item.operationId, item);
    if (operation) operations.set(operation.operationId, operation);
    const rewards = new Map(previous.rewardRequests.map(item => [item.requestId, item]));
    for (const item of view.rewardRequests) rewards.set(item.requestId, item);
    const scoped = { ...previous, connection: view.connection, currentScope: view.currentScope,
      preparation: view.preparation, cards: view.cards,
      allowedActions: view.allowedActions, reasons: view.reasons,
      operations: [...operations.values()], rewardRequests: [...rewards.values()],
      operationCards: { ...previous.operationCards, ...view.operationCards,
        ...(operation && card ? { [operation.operationId]: card } : {}) } };
    return projectUnconfirmedSync(scoped, view.storageAvailability);
  }
  if (!operation) return view;
  if (!card) throw new Error('OPERATION_CARD_REQUIRED');
  const state = view.cards[card];
  // This projects an already decided chain/receipt outcome; it never infers success from a hash.
  const phase = phaseOf(operation, state.phase);
  return { ...view, operations: [...view.operations.filter(item => item.operationId !== operation.operationId), operation],
    operationCards: { ...view.operationCards, [operation.operationId]: card },
    cards: { ...view.cards, [card]: { ...state, phase } } };
}
