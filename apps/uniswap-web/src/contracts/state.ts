import type { OperationRef, Scope } from '@confidential-utxo/uniswap';

export type Card = 'reward' | 'pay' | 'deposit' | 'withdraw';

export type CardPhase =
  | 'needs-preparation'
  | 'invalid-input'
  | 'ready'
  | 'preparing'
  | 'confirm-terms'
  | 'awaiting-approval'
  | 'submitting'
  | 'pending'
  | 'confirmed-receipt-pending'
  | 'complete'
  | 'failed'
  | 'unknown'
  | 'receipt-invalid';

export type ApprovalPurpose =
  | 'recipient-key'
  | 'api-login'
  | 'recipient-info'
  | 'pool-authorization'
  | 'payment-authorization'
  | 'transaction';

export type ReasonCode =
  | 'RESULT_UNKNOWN'
  | 'INPUT_INVALID'
  | 'PREPARATION_MISSING'
  | 'QUOTE_STALE'
  | 'TERMS_CHANGED'
  | 'RESERVATION_PENDING'
  | 'INPUT_RESERVED'
  | 'AUTHORIZATION_ACTIVE'
  | 'RECEIPT_INVALID'
  | 'SERVICE_UNAVAILABLE'
  | 'SCOPE_CHANGED'
  | 'UNSUPPORTED'
  | 'NOT_ALLOWED';

export interface CardState {
  readonly phase: CardPhase;
  readonly input: Readonly<Record<string, string>>;
  readonly reason?: ReasonCode;
  readonly approvalPurpose?: ApprovalPurpose;
  readonly quote?: {
    readonly startedAt: number;
    readonly quoteOut: bigint;
    readonly minAmountOut: bigint;
    readonly deadline: number;
  };
}

export interface ViewState {
  readonly scope: Scope;
  readonly publicEthWei: bigint;
  readonly availablePrivateWei: bigint;
  readonly pendingPrivateWei: bigint;
  readonly checkedAt?: number;
  readonly isStale: boolean;
  readonly cards: Readonly<Record<Card, CardState>>;
  readonly operations: readonly OperationRef[];
  readonly allowedActions: readonly string[];
  readonly reasons: Readonly<Record<string, ReasonCode>>;
}
