import type { Bytes32, FinalizedCheckpoint, Scope, StoredOperation } from '@confidential-utxo/uniswap';
import { getOperation } from './store.js';

export interface FinalizedView {
  readonly checkpoint: FinalizedCheckpoint;
  readonly input: { readonly blockHash: string; readonly spent: boolean };
  readonly pay: { readonly blockHash: string; readonly succeeded: boolean };
}

export interface FinalizedReader {
  readFinalizedView(scope: Scope, record: StoredOperation['record']): Promise<FinalizedView | undefined>;
}

function classify(record: StoredOperation['record'], view: FinalizedView): StoredOperation['status'] {
  const hash = view.checkpoint.blockHash.toLowerCase();
  if (view.input.blockHash.toLowerCase() !== hash || view.pay.blockHash.toLowerCase() !== hash) return 'unknown';
  if (view.pay.succeeded) return 'finalized-success';
  if (view.input.spent) return 'consumed';
  if (record.kind === 'pay' && BigInt(view.checkpoint.blockTimestamp) > record.deadline) return 'released';
  return 'reserved';
}

export async function reconcileOperation(
  storage: DurableObjectStorage, scope: Scope, recordId: string, reader: FinalizedReader,
): Promise<StoredOperation> {
  const before = getOperation(storage, scope, recordId);
  if (before === undefined) throw new Error('NOT_FOUND');
  if (before.status === 'released' || before.status === 'consumed' || before.status === 'finalized-success') return before;
  let view: FinalizedView | undefined;
  try { view = await reader.readFinalizedView(scope, before.record); } catch { /* unavailable RPC */ }
  const nextStatus = view === undefined ? 'unknown' : classify(before.record, view);
  return storage.transactionSync(() => {
    const current = getOperation(storage, scope, recordId);
    if (current === undefined) throw new Error('NOT_FOUND');
    if (current.stateVersion !== before.stateVersion || current.revision !== before.revision
      || current.status === 'released' || current.status === 'consumed' || current.status === 'finalized-success') return current;
    if (nextStatus === current.status && (view === undefined || current.checkpoint?.blockHash === view.checkpoint.blockHash)) return current;
    const checkpoint = nextStatus === 'unknown' ? undefined : view!.checkpoint;
    storage.sql.exec(
      `UPDATE operations SET status = ?, state_version = state_version + 1,
       checkpoint_block_number = ?, checkpoint_block_hash = ?, checkpoint_block_timestamp = ?
       WHERE deployment_id = ? AND owner = ? AND record_id = ? AND state_version = ?`,
      nextStatus, checkpoint?.blockNumber ?? null, checkpoint?.blockHash ?? null, checkpoint?.blockTimestamp ?? null,
      scope.deploymentId, scope.owner.toLowerCase(), recordId, current.stateVersion,
    );
    if (nextStatus === 'released' || nextStatus === 'consumed' || nextStatus === 'finalized-success') {
      storage.sql.exec(
        'DELETE FROM active_reservations WHERE deployment_id = ? AND owner = ? AND input_id = ? AND record_id = ?',
        scope.deploymentId, scope.owner.toLowerCase(), current.record.inputId, recordId,
      );
    }
    return getOperation(storage, scope, recordId)!;
  });
}
