import type {
  Address,
  AttemptId,
  Bytes32,
  InputId,
  OperationId,
  PaymentId,
  RequestId,
  Scope,
  TxHash,
} from './domain.js';

export interface EncryptedBundle {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly tag: string;
}

export interface ReservationBase {
  readonly recordId: Bytes32;
  readonly scope: Scope;
  readonly inputId: InputId;
  readonly operationId: OperationId;
  readonly contentHash: Bytes32;
  readonly encryptedBundle: EncryptedBundle;
  readonly signatureStarted: boolean;
  readonly attemptIds: readonly AttemptId[];
}

export type OperationRecord =
  | (ReservationBase & {
      readonly kind: 'pay';
      readonly paymentId: PaymentId;
      readonly deadline: bigint;
    })
  | (ReservationBase & {
      readonly kind: 'withdraw';
      readonly paymentId?: never;
      readonly deadline?: never;
    });

export interface SavedOperation {
  readonly record: OperationRecord;
  readonly revision: number;
}

export interface SignedRecipientInfo {
  readonly owner: Address;
  readonly publicKey: Bytes32;
  readonly signature: `0x${string}`;
}

export interface RewardRequest {
  readonly scope: Scope;
  readonly requestId: RequestId;
  readonly amountWei: bigint;
  readonly recipientInfo: SignedRecipientInfo;
}

export type RewardStatus =
  | 'accepted'
  | 'queued'
  | 'processing'
  | 'pending'
  | 'unknown'
  | 'finalized'
  | 'received'
  | 'ended-without-distribution';

export interface RewardRecord extends RewardRequest {
  readonly status: RewardStatus;
  readonly operationId?: OperationId;
  readonly attemptIds: readonly AttemptId[];
  readonly txHashes: readonly TxHash[];
  readonly outputId?: Bytes32;
  readonly blockHash?: Bytes32;
}

export type StoreErrorCode =
  | 'CONFLICT'
  | 'REVISION_CONFLICT'
  | 'UNAVAILABLE'
  | 'NOT_FOUND'
  | 'PENDING_REQUEST'
  | 'NOT_FINALIZED';

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code);
    this.name = 'StoreError';
  }
}

export interface OperationStore {
  put(record: OperationRecord, expectedRevision: number): SavedOperation;
  list(scope: Scope): readonly SavedOperation[];
  get(scope: Scope, recordId: Bytes32): SavedOperation | undefined;
}

export interface RewardStore {
  create(request: RewardRequest): RewardRecord;
  list(scope: Scope): readonly RewardRecord[];
  get(scope: Scope, requestId: RequestId): RewardRecord | undefined;
  markReceived(scope: Scope, requestId: RequestId, outputId: Bytes32, blockHash: Bytes32): RewardRecord;
}
