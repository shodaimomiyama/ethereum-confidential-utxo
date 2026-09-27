import type { RewardRecord, Scope } from '@confidential-utxo/uniswap';
import { getReward } from './store.js';
import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import { decodeRewardSecret, decryptRewardState, encodeRewardSecret, encryptRewardState } from './crypto.js';

export type OperatorAuthorization = { readonly authorized: boolean };

/** Internal control operation; no public HTTP route may call this. */
export async function endUndistributedReward(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, operatorAuth: OperatorAuthorization): Promise<RewardRecord> {
  if (!operatorAuth.authorized) throw new Error('OPERATOR_UNAUTHORIZED');
  return storage.transactionSync(() => {
    const row = storage.sql.exec<{ owner: string; status: string }>(
      'SELECT owner, status FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
      deploymentId, requestId,
    ).toArray()[0];
    if (row === undefined) throw new Error('NOT_FOUND');
    const scope = { deploymentId, owner: row.owner } as Scope;
    if (row.status === 'ended-without-distribution') return getReward(storage, scope, requestId)!;
    const draft = storage.sql.exec<{ phase: string }>(
      'SELECT phase FROM reward_drafts WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
    ).toArray()[0];
    const attempt = storage.sql.exec<{ attempt_no: number }>(
      'SELECT attempt_no FROM reward_attempts WHERE deployment_id = ? AND request_id = ? LIMIT 1',
      deploymentId, requestId,
    ).toArray()[0];
    if (draft?.phase === 'signature-started' || attempt !== undefined
      || ['pending', 'unknown'].includes(row.status)) throw new Error('CANCELLATION_REQUIRED');
    if (!['accepted', 'queued', 'processing'].includes(row.status)
      || (row.status === 'processing' && draft === undefined)
      || (draft !== undefined && !['claimed', 'draft-saved'].includes(draft.phase))) {
      throw new Error('REWARD_END_CONFLICT');
    }
    storage.sql.exec(`UPDATE reward_requests SET status = 'ended-without-distribution',
      state_version = state_version + 1 WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    storage.sql.exec(`UPDATE reward_reservations SET released = 1
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    storage.sql.exec(`UPDATE reward_inputs SET status = 'released'
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    return getReward(storage, scope, requestId)!;
  });
}

export type CancellationDraft = { operationId: string; signature?: string };
export type CancellationPorts = {
  build(): Promise<{ operationId: string; inputId: string; draft: CancellationDraft }>;
  sign(draft: CancellationDraft): Promise<CancellationDraft>;
  prepare(draft: CancellationDraft): Promise<{ raw: Hex; hash: Hex; nonce: number }>;
  broadcast(raw: Hex): Promise<void>;
  /** 'cancel-finalized' certifies the cancellation input was consumed by that operation and the old operation did not succeed. */
  observe(oldOperationId: string, cancellationOperationId: string, inputId: string): Promise<
    'unknown' | 'none' | 'old-finalized' | 'cancel-finalized'>;
};

type CancellationRow = { phase: string; operation_id: string; input_id: string;
  encrypted_draft: string; encrypted_raw: string | null; tx_hash: string | null; nonce: number | null };

/** Resumes the same cancellation operation and raw after any interruption. */
export async function advanceSignedCancellation(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, operatorAuth: OperatorAuthorization, key: Uint8Array,
  ports: CancellationPorts): Promise<RewardRecord> {
  if (!operatorAuth.authorized) throw new Error('OPERATOR_UNAUTHORIZED');
  const original = storage.sql.exec<{ owner: string; status: string; operation_id: string | null }>(
    'SELECT owner, status, operation_id FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
    deploymentId, requestId,
  ).toArray()[0];
  if (original === undefined) throw new Error('NOT_FOUND');
  const scope = { deploymentId, owner: original.owner } as Scope;
  if (original.status === 'ended-without-distribution' || original.status === 'finalized'
    || original.status === 'received') return getReward(storage, scope, requestId)!;
  const originalDraft = storage.sql.exec<{ phase: string }>(
    'SELECT phase FROM reward_drafts WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
  ).toArray()[0];
  if (originalDraft?.phase !== 'signature-started' || original.operation_id === null) {
    throw new Error('REWARD_CANCELLATION_CONFLICT');
  }
  const read = () => storage.sql.exec<CancellationRow>(
    `SELECT phase, operation_id, input_id, encrypted_draft, encrypted_raw, tx_hash, nonce
     FROM reward_cancellations WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId,
  ).toArray()[0];
  let row = read();
  if (row === undefined) {
    const prepared = await ports.build();
    const encrypted = await encryptRewardState(key, deploymentId, requestId, 1, encodeRewardSecret(prepared.draft));
    storage.transactionSync(() => {
      if (read() !== undefined) throw new Error('REWARD_CANCELLATION_CONFLICT');
      storage.sql.exec(`INSERT INTO reward_cancellations (deployment_id, request_id, phase,
        operation_id, input_id, encrypted_draft) VALUES (?, ?, 'draft-saved', ?, ?, ?)`,
      deploymentId, requestId, prepared.operationId, prepared.inputId, encrypted);
    });
    row = read()!;
  }
  if (row.phase === 'draft-saved') {
    storage.sql.exec(`UPDATE reward_cancellations SET phase = 'signature-started'
      WHERE deployment_id = ? AND request_id = ? AND phase = 'draft-saved'`, deploymentId, requestId);
    row = read()!;
  }
  if (row.phase === 'signature-started') {
    const draft = decodeRewardSecret<CancellationDraft>(await decryptRewardState(key, deploymentId,
      requestId, 1, row.encrypted_draft));
    if (draft.operationId !== row.operation_id) throw new Error('REWARD_CANCELLATION_CONFLICT');
    const signed = await ports.sign(draft);
    if (signed.operationId !== row.operation_id || signed.signature === undefined) {
      throw new Error('REWARD_CANCELLATION_CONFLICT');
    }
    const encrypted = await encryptRewardState(key, deploymentId, requestId, 1, encodeRewardSecret(signed));
    storage.sql.exec(`UPDATE reward_cancellations SET phase = 'signed', encrypted_draft = ?
      WHERE deployment_id = ? AND request_id = ? AND phase = 'signature-started'`,
    encrypted, deploymentId, requestId);
    row = read()!;
  }
  if (row.phase === 'signed') {
    const signed = decodeRewardSecret<CancellationDraft>(await decryptRewardState(key, deploymentId,
      requestId, 1, row.encrypted_draft));
    if (signed.operationId !== row.operation_id || signed.signature === undefined) {
      throw new Error('REWARD_CANCELLATION_CONFLICT');
    }
    const prepared = await ports.prepare(signed);
    if (keccak256(prepared.raw).toLowerCase() !== prepared.hash.toLowerCase()
      || !Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) {
      throw new Error('REWARD_CANCELLATION_CONFLICT');
    }
    const encrypted = await encryptRewardState(key, deploymentId, requestId, 2, prepared.raw);
    storage.sql.exec(`UPDATE reward_cancellations SET phase = 'raw-saved', encrypted_raw = ?,
      tx_hash = ?, nonce = ? WHERE deployment_id = ? AND request_id = ? AND phase = 'signed'`,
    encrypted, prepared.hash, prepared.nonce, deploymentId, requestId);
    row = read()!;
  }
  if (row.phase !== 'raw-saved' || row.encrypted_raw === null || row.tx_hash === null) {
    throw new Error('REWARD_CANCELLATION_CONFLICT');
  }
  const observed = await ports.observe(original.operation_id, row.operation_id, row.input_id);
  if (observed === 'old-finalized') throw new Error('ORIGINAL_FINALIZED');
  if (observed === 'cancel-finalized') {
    storage.transactionSync(() => {
      const latest = storage.sql.exec<{ status: string; operation_id: string | null }>(
        'SELECT status, operation_id FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
        deploymentId, requestId,
      ).toArray()[0];
      if (latest?.operation_id !== original.operation_id
        || !['pending', 'unknown', 'processing'].includes(latest.status)) {
        throw new Error('REWARD_CANCELLATION_CONFLICT');
      }
      storage.sql.exec(`UPDATE reward_requests SET status = 'ended-without-distribution',
        state_version = state_version + 1 WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
      storage.sql.exec(`UPDATE reward_reservations SET released = 1
        WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
      storage.sql.exec(`UPDATE reward_inputs SET status = 'consumed'
        WHERE deployment_id = ? AND input_id = ?`, deploymentId, row.input_id);
    });
    return getReward(storage, scope, requestId)!;
  }
  if (observed === 'none') {
    const raw = await decryptRewardState(key, deploymentId, requestId, 2, row.encrypted_raw) as Hex;
    if (keccak256(raw).toLowerCase() !== row.tx_hash.toLowerCase()) throw new Error('REWARD_CANCELLATION_CONFLICT');
    await ports.broadcast(raw);
  }
  return getReward(storage, scope, requestId)!;
}
