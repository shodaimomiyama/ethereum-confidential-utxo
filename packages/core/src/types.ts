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
export type UtxoState = { exists: boolean; consumedBy?: Hex };
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
  outputLogs: {
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
