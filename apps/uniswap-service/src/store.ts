import type { Bytes32, OperationRecord, Scope, StoredOperation } from '@confidential-utxo/uniswap';

export type InputState = 'owned-unspent' | 'spent' | 'other-owner' | 'unknown';
export interface InputReader {
  readInput(scope: Scope, inputId: OperationRecord['inputId']): Promise<InputState>;
}

type Row = {
  deployment_id: string; owner: string; record_id: string; input_id: string; operation_id: string;
  kind: 'pay' | 'withdraw'; payment_id: string | null; deadline: string | null;
  content_hash: string; encrypted_bundle_json: string; signature_started: number;
  revision: number; state_version: number; status: StoredOperation['status'];
  checkpoint_block_number: string | null; checkpoint_block_hash: string | null;
  checkpoint_block_timestamp: string | null;
};

function normalize(scope: Scope): string { return scope.owner.toLowerCase(); }

function attempts(storage: DurableObjectStorage, scope: Scope, recordId: string): OperationRecord['attemptIds'] {
  return storage.sql.exec<{ attempt_id: string }>(
    'SELECT attempt_id FROM operation_attempts WHERE deployment_id = ? AND owner = ? AND record_id = ? ORDER BY position',
    scope.deploymentId, normalize(scope), recordId,
  ).toArray().map(({ attempt_id }) => attempt_id as OperationRecord['attemptIds'][number]);
}

function fromRow(storage: DurableObjectStorage, scope: Scope, row: Row): StoredOperation {
  const base = {
    scope, recordId: row.record_id as OperationRecord['recordId'],
    inputId: row.input_id as OperationRecord['inputId'],
    operationId: row.operation_id as OperationRecord['operationId'],
    contentHash: row.content_hash as OperationRecord['contentHash'],
    encryptedBundle: JSON.parse(row.encrypted_bundle_json) as OperationRecord['encryptedBundle'],
    signatureStarted: row.signature_started !== 0,
    attemptIds: attempts(storage, scope, row.record_id),
  };
  const record: OperationRecord = row.kind === 'pay'
    ? { ...base, kind: 'pay', paymentId: row.payment_id as NonNullable<OperationRecord['paymentId']>, deadline: BigInt(row.deadline!) }
    : { ...base, kind: 'withdraw' };
  return {
    record, revision: row.revision, stateVersion: row.state_version, status: row.status,
    ...(row.checkpoint_block_hash === null ? {} : { checkpoint: {
      blockNumber: row.checkpoint_block_number!, blockHash: row.checkpoint_block_hash as Bytes32,
      blockTimestamp: row.checkpoint_block_timestamp!,
    } }),
  };
}

export function getOperation(storage: DurableObjectStorage, scope: Scope, recordId: string): StoredOperation | undefined {
  const row = storage.sql.exec<Row>(
    'SELECT * FROM operations WHERE deployment_id = ? AND owner = ? AND record_id = ?',
    scope.deploymentId, normalize(scope), recordId.toLowerCase(),
  ).toArray()[0];
  return row === undefined ? undefined : fromRow(storage, scope, row);
}

export function listOperations(storage: DurableObjectStorage, scope: Scope, cursor?: string): {
  readonly records: readonly StoredOperation[]; readonly nextCursor?: Bytes32;
} {
  const rows = storage.sql.exec<Row>(
    'SELECT * FROM operations WHERE deployment_id = ? AND owner = ? AND record_id > ? ORDER BY record_id LIMIT 101',
    scope.deploymentId, normalize(scope), cursor?.toLowerCase() ?? '',
  ).toArray();
  const page = rows.slice(0, 100).map((row) => fromRow(storage, scope, row));
  return { records: page, ...(rows.length > 100 ? { nextCursor: page[99]!.record.recordId } : {}) };
}

function sameImmutable(a: OperationRecord, b: OperationRecord): boolean {
  return a.kind === b.kind && a.recordId === b.recordId && a.inputId === b.inputId
    && a.operationId === b.operationId && a.contentHash === b.contentHash
    && (a.kind !== 'pay' || (b.kind === 'pay' && a.paymentId === b.paymentId && a.deadline === b.deadline));
}

function sameMutable(a: OperationRecord, b: OperationRecord): boolean {
  return JSON.stringify(a.encryptedBundle) === JSON.stringify(b.encryptedBundle)
    && a.signatureStarted === b.signatureStarted
    && JSON.stringify(a.attemptIds) === JSON.stringify(b.attemptIds);
}

export async function putOperation(
  storage: DurableObjectStorage, scope: Scope, record: OperationRecord,
  expectedRevision: number, inputReader: InputReader, assertWritable?: () => void,
): Promise<StoredOperation> {
  record = {
    ...record,
    recordId: record.recordId.toLowerCase(), inputId: record.inputId.toLowerCase(),
    operationId: record.operationId.toLowerCase(), contentHash: record.contentHash.toLowerCase(),
    ...(record.kind === 'pay' ? { paymentId: record.paymentId.toLowerCase() } : {}),
  } as OperationRecord;
  if (record.scope.deploymentId !== scope.deploymentId || normalize(record.scope) !== normalize(scope)) {
    throw new Error('SCOPE_MISMATCH');
  }
  const existing = getOperation(storage, scope, record.recordId);
  if (existing === undefined) {
    if (record.signatureStarted || record.attemptIds.length !== 0) throw new Error('REVISION_CONFLICT');
    const inputState = await inputReader.readInput(scope, record.inputId);
    if (inputState === 'unknown') throw new Error('SERVICE_UNAVAILABLE');
    if (inputState !== 'owned-unspent') throw new Error('RESERVATION_CONFLICT');
  }
  return storage.transactionSync(() => {
    assertWritable?.();
    const stopped = storage.sql.exec<{ status: string }>('SELECT status FROM environment_state WHERE id = 1').toArray()[0];
    if (stopped?.status === 'stopped') throw new Error('SERVICE_UNAVAILABLE');
    const current = getOperation(storage, scope, record.recordId);
    if (current !== undefined) {
      if (!sameImmutable(current.record, record)) throw new Error('RESERVATION_CONFLICT');
      if (sameMutable(current.record, record)) return current;
      if (current.status === 'released' || current.status === 'consumed' || current.status === 'finalized-success') {
        throw new Error('RESERVATION_CONFLICT');
      }
      if (current.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
      if (current.record.signatureStarted && !record.signatureStarted) throw new Error('REVISION_CONFLICT');
      if (current.record.attemptIds.some((id, i) => record.attemptIds[i] !== id)) throw new Error('REVISION_CONFLICT');
      if (current.record.encryptedBundle.nonce === record.encryptedBundle.nonce
        || JSON.stringify(current.record.encryptedBundle) === JSON.stringify(record.encryptedBundle)) {
        throw new Error('REVISION_CONFLICT');
      }
      storage.sql.exec(
        'UPDATE operations SET encrypted_bundle_json = ?, signature_started = ?, revision = revision + 1 WHERE deployment_id = ? AND owner = ? AND record_id = ?',
        JSON.stringify(record.encryptedBundle), Number(record.signatureStarted), scope.deploymentId, normalize(scope), record.recordId,
      );
      record.attemptIds.slice(current.record.attemptIds.length).forEach((attemptId, offset) => {
        storage.sql.exec('INSERT INTO operation_attempts (deployment_id, owner, record_id, position, attempt_id) VALUES (?, ?, ?, ?, ?)',
          scope.deploymentId, normalize(scope), record.recordId, current.record.attemptIds.length + offset, attemptId);
      });
      return getOperation(storage, scope, record.recordId)!;
    }
    if (expectedRevision !== 0) throw new Error('REVISION_CONFLICT');
    const active = storage.sql.exec<{ record_id: string }>(
      'SELECT record_id FROM active_reservations WHERE deployment_id = ? AND owner = ? AND input_id = ?',
      scope.deploymentId, normalize(scope), record.inputId,
    ).toArray()[0];
    if (active !== undefined) throw new Error('RESERVATION_CONFLICT');
    storage.sql.exec(
      `INSERT INTO operations (deployment_id, owner, record_id, input_id, operation_id, kind, payment_id, deadline,
       content_hash, encrypted_bundle_json, signature_started, revision, state_version, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'reserved')`,
      scope.deploymentId, normalize(scope), record.recordId, record.inputId, record.operationId,
      record.kind, record.kind === 'pay' ? record.paymentId : null,
      record.kind === 'pay' ? record.deadline.toString() : null,
      record.contentHash, JSON.stringify(record.encryptedBundle), Number(record.signatureStarted),
    );
    record.attemptIds.forEach((attemptId, position) => storage.sql.exec(
      'INSERT INTO operation_attempts (deployment_id, owner, record_id, position, attempt_id) VALUES (?, ?, ?, ?, ?)',
      scope.deploymentId, normalize(scope), record.recordId, position, attemptId,
    ));
    storage.sql.exec(
      'INSERT INTO active_reservations (deployment_id, owner, input_id, record_id) VALUES (?, ?, ?, ?)',
      scope.deploymentId, normalize(scope), record.inputId, record.recordId,
    );
    return getOperation(storage, scope, record.recordId)!;
  });
}
