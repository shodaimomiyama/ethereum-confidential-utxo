import type { OperationId, OperationRef, RequestId, Scope } from '@confidential-utxo/uniswap';
import type { Card, UiAction, ViewState } from '../contracts/index.js';
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

export function mapDecisionToView(previous: ViewState, result: OperationResult): ViewState {
  const { view, operation, card } = result;
  if (!sameScope(previous.scope, result.scope) || !sameScope(view.scope, result.scope)
    || view.operations.some(item => !sameScope(item.scope, result.scope))
    || (operation && !sameScope(operation.scope, result.scope))) throw new Error('SCOPE_CHANGED');
  if (!operation) return view;
  if (!card) throw new Error('OPERATION_CARD_REQUIRED');
  const state = view.cards[card];
  // This projects an already decided chain/receipt outcome; it never infers success from a hash.
  const phase = operation.chainOutcome === 'finalized-success'
    ? operation.receiptState === 'invalid' ? 'receipt-invalid'
      : operation.receiptState === 'pending' ? 'confirmed-receipt-pending' : 'complete'
    : state.phase;
  return { ...view, operations: [...view.operations.filter(item => item.operationId !== operation.operationId), operation],
    operationCards: { ...view.operationCards, [operation.operationId]: card },
    cards: { ...view.cards, [card]: { ...state, phase } } };
}
