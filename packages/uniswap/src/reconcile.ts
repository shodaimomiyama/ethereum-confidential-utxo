import type {
  Address, Bytes32, DeploymentId, InputId, OperationId, OperationRef,
  PaymentId, ReceiptState,
} from './domain.js';
import type { OperationRecord } from './storage.js';
import type { Checkpoint, ReceiptFailure, ReceivedUtxo } from '@confidential-utxo/core';

interface BlockRecord {
  readonly blockHash: Bytes32;
}

export interface FinalizedHistory {
  readonly chainId: bigint;
  readonly deploymentId: DeploymentId;
  readonly checkpoint: Checkpoint;
  readonly blockHash: Bytes32;
  readonly finalized: boolean;
  readonly canonical: boolean;
  readonly rpcConsistent: boolean;
  readonly adapter?: BlockRecord & {
    readonly paymentId: PaymentId;
    readonly operationId: OperationId;
    readonly owner: Address;
    readonly amountOut: bigint;
  };
  readonly pool?: BlockRecord & {
    readonly operationId: OperationId;
    readonly inputId: InputId;
    readonly changeOutputId: Bytes32;
  };
  readonly input?: BlockRecord & {
    readonly inputId: InputId;
    readonly consumed: boolean;
  };
  readonly change?: BlockRecord & {
    readonly outputId: Bytes32;
    readonly owner: Address;
  };
}

export interface CoreReceiptResult {
  readonly state: ReceiptState;
  readonly outputId?: Bytes32;
  readonly currentlyUnspent: boolean;
  readonly creationCheckpoint?: Checkpoint;
  readonly observationCheckpoint?: Checkpoint;
}

export function coreReceiptResult(result: ReceivedUtxo | ReceiptFailure): CoreReceiptResult {
  if (result.status === 'available' || result.status === 'spent') {
    return {
      state: 'confirmed', outputId: result.utxo.id as Bytes32,
      currentlyUnspent: result.status === 'available',
      creationCheckpoint: result.creationCheckpoint,
      observationCheckpoint: result.utxo.checkpoint,
    };
  }
  return {
    state: result.status === 'unknown' ? 'pending' : 'invalid',
    currentlyUnspent: false,
  };
}

export interface ReconciledPayment {
  readonly operation: OperationRef;
  readonly changeUsable: boolean;
}

function sameHex(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function reconcilePayment(
  ref: OperationRef,
  record: OperationRecord,
  history: FinalizedHistory,
  receipt: CoreReceiptResult,
  expectedChainId: bigint,
): ReconciledPayment {
  const matched = record.kind === 'pay'
    && history.finalized && history.canonical && history.rpcConsistent
    && history.chainId === expectedChainId
    && history.deploymentId === ref.scope.deploymentId
    && record.scope.deploymentId === ref.scope.deploymentId
    && sameHex(record.scope.owner, ref.scope.owner)
    && sameHex(record.operationId, ref.operationId)
    && sameHex(record.paymentId, ref.paymentId)
    && history.adapter !== undefined && history.pool !== undefined
    && history.input !== undefined && history.change !== undefined
    && [history.adapter, history.pool, history.input, history.change]
      .every((item) => sameHex(item.blockHash, history.blockHash))
    && sameHex(history.adapter.paymentId, record.paymentId)
    && sameHex(history.adapter.operationId, record.operationId)
    && sameHex(history.adapter.owner, record.scope.owner)
    && history.adapter.amountOut > 0n
    && sameHex(history.pool.operationId, record.operationId)
    && sameHex(history.pool.inputId, record.inputId)
    && sameHex(history.input.inputId, record.inputId)
    && history.input.consumed
    && sameHex(history.pool.changeOutputId, history.change.outputId)
    && sameHex(history.change.owner, record.scope.owner);

  if (!matched) {
    return {
      operation: { ...ref, chainOutcome: 'unknown', receiptState: 'pending' },
      changeUsable: false,
    };
  }

  if (receipt.state === 'confirmed'
    && (!sameHex(receipt.creationCheckpoint?.hash, history.blockHash)
      || receipt.creationCheckpoint?.mode !== history.checkpoint.mode
      || !sameHex(receipt.observationCheckpoint?.hash, history.checkpoint.hash)
      || receipt.observationCheckpoint?.number !== history.checkpoint.number
      || receipt.observationCheckpoint?.mode !== history.checkpoint.mode)) {
    return {
      operation: { ...ref, chainOutcome: 'unknown', receiptState: 'pending' },
      changeUsable: false,
    };
  }

  const receiptState = receipt.state === 'pending' ? 'pending'
    : receipt.state === 'invalid' ? 'invalid'
      : sameHex(receipt.outputId, history.change?.outputId) ? 'confirmed' : 'invalid';
  return {
    operation: { ...ref, chainOutcome: 'finalized-success', receiptState },
    changeUsable: receiptState === 'confirmed' && receipt.currentlyUnspent,
  };
}
