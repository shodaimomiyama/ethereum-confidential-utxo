import type { FinalizedCheckpoint, Scope, StoredOperation } from '@confidential-utxo/uniswap';
import { getOperation } from './store.js';

export interface FinalizedView {
  readonly checkpoint: FinalizedCheckpoint;
  readonly input: { readonly blockHash: string; readonly spent: boolean };
  readonly pay: { readonly blockHash: string; readonly succeeded: boolean };
  readonly operation?: { readonly blockHash: string; readonly succeeded: boolean };
}

export interface FinalizedReader {
  readFinalizedView(scope: Scope, record: StoredOperation['record']): Promise<FinalizedView | undefined>;
}

function classify(record: StoredOperation['record'], view: FinalizedView): StoredOperation['status'] {
  const hash = view.checkpoint.blockHash.toLowerCase();
  if (view.input.blockHash.toLowerCase() !== hash || view.pay.blockHash.toLowerCase() !== hash
    || (view.operation !== undefined && view.operation.blockHash.toLowerCase() !== hash)) return 'unknown';
  if (record.kind === 'pay' && view.pay.succeeded) return 'finalized-success';
  if (record.kind === 'withdraw' && view.operation?.succeeded) return 'finalized-success';
  if (view.input.spent) return 'consumed';
  if (record.kind === 'pay' && BigInt(view.checkpoint.blockTimestamp) > record.deadline) return 'released';
  return 'reserved';
}

export async function reconcileOperation(
  storage: DurableObjectStorage, scope: Scope, recordId: string, reader: FinalizedReader,
  assertWritable?: () => void,
): Promise<StoredOperation> {
  recordId = recordId.toLowerCase();
  const before = getOperation(storage, scope, recordId);
  if (before === undefined) throw new Error('NOT_FOUND');
  let view: FinalizedView | undefined;
  try { view = await reader.readFinalizedView(scope, before.record); } catch { /* unavailable RPC */ }
  const nextStatus = view === undefined ? 'unknown' : classify(before.record, view);
  return storage.transactionSync(() => {
    assertWritable?.();
    const stopped = storage.sql.exec<{ status: string }>('SELECT status FROM environment_state WHERE id = 1').toArray()[0];
    if (stopped?.status === 'stopped') return getOperation(storage, scope, recordId)!;
    const current = getOperation(storage, scope, recordId);
    if (current === undefined) throw new Error('NOT_FOUND');
    if (current.stateVersion !== before.stateVersion || current.revision !== before.revision) return current;
    if (current.status === 'released' || current.status === 'consumed' || current.status === 'finalized-success') {
      const conflictingView = view !== undefined && (
        (current.checkpoint?.blockNumber === view.checkpoint.blockNumber
          && current.checkpoint.blockHash.toLowerCase() !== view.checkpoint.blockHash.toLowerCase())
        || (nextStatus !== 'unknown' && nextStatus !== current.status)
      );
      if (!conflictingView) return current;
      storage.sql.exec(
        "INSERT INTO environment_state (id, status, generation, reason) VALUES (1, 'stopped', '', 'finalized-reorg') ON CONFLICT(id) DO UPDATE SET status = 'stopped', reason = 'finalized-reorg'",
      );
      storage.sql.exec(
        `UPDATE operations SET status = 'unknown', state_version = state_version + 1,
         checkpoint_block_number = NULL, checkpoint_block_hash = NULL, checkpoint_block_timestamp = NULL
         WHERE deployment_id = ? AND owner = ? AND record_id = ?`,
        scope.deploymentId, scope.owner.toLowerCase(), recordId,
      );
      return getOperation(storage, scope, recordId)!;
    }
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
