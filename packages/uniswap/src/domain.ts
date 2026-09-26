declare const domainBrand: unique symbol;

export type Branded<Value extends string, Name extends string> = Value & {
  readonly [domainBrand]: Name;
};

export type Address = Branded<`0x${string}`, 'Address'>;
export type Bytes32 = Branded<`0x${string}`, 'Bytes32'>;
export type DeploymentId = Branded<string, 'DeploymentId'>;
export type OperationId = Branded<`0x${string}`, 'OperationId'>;
export type PaymentId = Branded<`0x${string}`, 'PaymentId'>;
export type AttemptId = Branded<string, 'AttemptId'>;
export type RequestId = Branded<`0x${string}`, 'RequestId'>;
export type TxHash = Branded<`0x${string}`, 'TxHash'>;
export type InputId = Branded<`0x${string}`, 'InputId'>;

export interface Scope {
  readonly deploymentId: DeploymentId;
  readonly owner: Address;
}

export type ChainOutcome =
  | 'not-submitted'
  | 'pending'
  | 'finalized-success'
  | 'finalized-failure'
  | 'unknown';

export type ReceiptState = 'none' | 'pending' | 'confirmed' | 'invalid';

export interface OperationRef {
  readonly scope: Scope;
  readonly operationId: OperationId;
  readonly paymentId?: PaymentId;
  readonly attemptIds: readonly AttemptId[];
  readonly txHashes: readonly TxHash[];
  readonly chainOutcome: ChainOutcome;
  readonly receiptState: ReceiptState;
}
