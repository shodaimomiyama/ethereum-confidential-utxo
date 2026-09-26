import type { OperationId, OperationRef, RequestId, RewardStatus, Scope } from '@confidential-utxo/uniswap';

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

export type ValidationReason =
  | ReasonCode
  | 'NO_SINGLE_INPUT'
  | 'GAS_REQUIRED'
  | 'WRONG_NETWORK'
  | 'KEY_REQUIRED'
  | 'REWARD_PENDING'
  | 'REWARD_DUPLICATE'
  | 'TERMS_EXPIRED'
  | 'UNSUPPORTED_RECIPIENT'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_DECIMAL'
  | 'MINIMUM_NOT_MET'
  | 'INPUT_USED';

export interface CardState {
  readonly phase: CardPhase;
  readonly input: Readonly<Record<string, string>>;
  readonly reason?: ValidationReason;
  readonly approvalPurpose?: ApprovalPurpose;
  readonly quote?: {
    readonly startedAt: number;
    readonly quoteOut: bigint;
    readonly minAmountOut: bigint;
    readonly deadline: number;
  };
  readonly proposedQuote?: CardState['quote'];
}

export interface RewardRequestRef {
  readonly requestId: RequestId;
  readonly status: RewardStatus;
  readonly operationId?: OperationId;
}

export interface ViewState {
  readonly scope: Scope;
  readonly publicEthWei: bigint;
  readonly availablePrivateWei: bigint;
  readonly pendingPrivateWei: bigint;
  readonly checkedAt?: number;
  readonly isStale: boolean;
  readonly storageAvailability: 'healthy' | 'unavailable' | 'rollback';
  readonly cards: Readonly<Record<Card, CardState>>;
  readonly operations: readonly OperationRef[];
  readonly rewardRequests: readonly RewardRequestRef[];
  readonly allowedActions: readonly string[];
  readonly reasons: Readonly<Record<string, ReasonCode>>;
}
