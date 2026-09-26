import type { BalanceProof, G1Point, Opening, RangeProof } from "@confidential-utxo/crypto";
import type { Address, Hex } from "viem";

export type Context = {
  chainId: bigint;
  pool: Address;
  deploymentBlock: bigint;
  verifier: Address;
  parametersHash: Hex;
  finalityMode: "finalized" | "local-simulated";
};

export type PublicOutput = {
  owner: Address;
  commitment: G1Point;
  receiptFormat: 1;
  packet: Hex;
};

export type OperationRequest = {
  kind: 0 | 1 | 2;
  owner: Address;
  salt: Hex;
  inputIds: Hex[];
  outputs: PublicOutput[];
  d: bigint;
  w: bigint;
  destination: Address;
};

export type Checkpoint = {
  number: bigint;
  hash: Hex;
  mode: "finalized" | "local-simulated";
};

export type OwnedUtxo = {
  id: Hex;
  owner: Address;
  opening: Opening;
  commitment: G1Point;
  checkpoint: Checkpoint;
  status: "available" | "spent" | "pending" | "unknown";
  chainId: bigint;
  pool: Address;
};

export type Complete<T> = { complete: true; blockHash: Hex; value: T };
export type Incomplete = { complete: false; reason: "RPC" | "GAP" | "HASH_MISMATCH" };
export type Observation<T> = Complete<T> | Incomplete;
export type UtxoState = { exists: boolean; owner?: Address; commitment?: G1Point; consumedBy?: Hex };
export type OperationSuccess = { executed: boolean; operation?: OperationRequest };
export type ObservedOperation = {
  request: OperationRequest;
  success?: {
    operationId: Hex;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
  };
  /** InputConsumed evidence; synchronization requires every input log. */
  inputLogs?: {
    operationId: Hex;
    inputId: Hex;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
  }[];
  outputLogs: {
    operationId: Hex;
    output: PublicOutput;
    outputId: Hex;
    outputIndex: number;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
  }[];
};

export interface HistoryPort {
  getFinalizedCheckpoint(): Promise<Checkpoint | null>;
  getContext(point: Checkpoint): Promise<Observation<Context>>;
  /** Complete only when the header is canonical ancestry of point (including point itself).
   * The envelope blockHash binds that ancestry assertion to point.hash.
   */
  getCanonicalHeader(number: bigint, point: Checkpoint): Promise<Observation<{ number: bigint; hash: Hex }>>;
  /** All Pool operations in the inclusive range, with complete success/input/output logs. */
  getOperations(fromBlock: bigint, point: Checkpoint): Promise<Observation<ObservedOperation[]>>;
  getUtxo(id: Hex, point: Checkpoint): Promise<Observation<UtxoState>>;
  getOperationSuccess(id: Hex, point: Checkpoint): Promise<Observation<OperationSuccess>>;
  getLatestHeader(): Promise<{ number: bigint; hash: Hex } | null>;
  getLatestUtxo(id: Hex, point: { number: bigint; hash: Hex }): Promise<Observation<UtxoState>>;
  getLatestOperationSuccess(id: Hex, point: { number: bigint; hash: Hex }): Promise<Observation<OperationSuccess>>;
}

export type OperationAuthorizationTypedData = {
  domain: {
    name: "Ethereum Confidential UTXO";
    version: "1";
    chainId: bigint;
    verifyingContract: Address;
  };
  primaryType: "OperationAuthorization";
  types: { OperationAuthorization: readonly { name: string; type: string }[] };
  message: { operationId: Hex; owner: Address; authScheme: 1; authVersion: 1 };
};

export type LocalDraft = {
  context: Context;
  request: OperationRequest;
  operationId: Hex;
  outputIds: Hex[];
  openings: Opening[];
  inputOpenings: Opening[];
  balanceProof: BalanceProof;
  rangeProofs: RangeProof[];
  signature?: Hex;
};

export interface ReceiptKeyPort {
  getKey(owner: Address): Promise<Uint8Array>;
}

export interface SignerPort {
  signTypedData(data: OperationAuthorizationTypedData): Promise<Hex>;
}

export interface StoragePort {
  saveDraft(draft: LocalDraft): Promise<"saved" | "unknown">;
}

/** Outer transaction evidence is independent of logical success and receipt ownership. */
export type SubmissionAttempt = {
  txHash?: Hex;
  outer: "pending" | "success" | "failed" | "unconfirmed";
  blockNumber?: bigint;
  blockHash?: Hex;
  failure?: "OUTER_REVERT" | "INTERNAL_REVERT";
};
export type OperationSuccessEvidence = {
  context: Context;
  checkpoint: Checkpoint;
  event: ObservedOperation;
  record: Observation<OperationSuccess>;
  header: Observation<{ number: bigint; hash: Hex }>;
};
export type AttemptObservation = SubmissionAttempt & {
  /** A label alone never establishes success. */
  operation?: "unconfirmed" | "executed";
  evidence?: OperationSuccessEvidence;
};
export type OperationTracking = {
  operationId: Hex;
  attempts: SubmissionAttempt[];
  operation: "executed" | "unconfirmed";
  checkpoint?: Checkpoint;
  /** Receipt ownership is established separately through inspectReceipt/synchronize. */
  receipt: "unconfirmed";
};
