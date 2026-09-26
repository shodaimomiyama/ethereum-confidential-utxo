import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import type { Hex } from 'viem';
import { decryptRewardState, encryptRewardState } from './crypto.js';
import { prepareSignedRaw } from '@confidential-utxo/ethereum';
import type { RawSigner, SendOptions, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { HistoryPort, PublicSubmission } from '@confidential-utxo/core';

export type SignedRewardRaw = { raw: Hex; hash: Hex; nonce: number; operationId: string };
export type RewardAttempt = SignedRewardRaw & { attemptNo: number; outerStatus: 'stored' | 'pending' | 'unknown' };
export type RawRpc = { sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex> };

export async function prepareAndStoreRewardAttempt(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, key: Uint8Array, verified: VerifiedDeployment, history: HistoryPort,
  signer: RawSigner, submission: PublicSubmission, options: SendOptions = {}): Promise<number> {
  const prepared = await prepareSignedRaw(verified, history, signer, submission, options);
  return saveRewardAttempt(storage, deploymentId, requestId, key, prepared);
}

type AttemptRow = { attempt_no: number; operation_id: string; nonce: number;
  tx_hash: string; encrypted_raw: string; outer_status: string };

/** Persists every signed candidate before it can reach an RPC. */
export async function saveRewardAttempt(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, key: Uint8Array, attempt: SignedRewardRaw,
  beforeWrite: () => void = () => {}): Promise<number> {
  if (!/^0x[0-9a-fA-F]+$/.test(attempt.raw) || keccak256(attempt.raw).toLowerCase() !== attempt.hash.toLowerCase()
    || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0) throw new Error('INVALID_REWARD_ATTEMPT');
  let transaction: ReturnType<typeof parseTransaction>;
  try { transaction = parseTransaction(attempt.raw); }
  catch { throw new Error('INVALID_REWARD_ATTEMPT'); }
  if (transaction.type !== 'eip1559' || transaction.nonce !== attempt.nonce || transaction.to == null
    || transaction.chainId === undefined || transaction.maxFeePerGas === undefined
    || transaction.maxPriorityFeePerGas === undefined || transaction.gas === undefined
    || transaction.maxFeePerGas < transaction.maxPriorityFeePerGas) throw new Error('INVALID_REWARD_ATTEMPT');
  const prior = storage.sql.exec<AttemptRow>(
    `SELECT attempt_no, operation_id, nonce, tx_hash, encrypted_raw, outer_status
     FROM reward_attempts WHERE deployment_id = ? AND request_id = ? ORDER BY attempt_no`,
    deploymentId, requestId,
  ).toArray();
  if (prior.length > 0) {
    const previous = prior.at(-1)!;
    const previousRaw = await decryptRewardState(key, deploymentId, requestId,
      previous.attempt_no, previous.encrypted_raw) as Hex;
    let old: ReturnType<typeof parseTransaction>;
    try { old = parseTransaction(previousRaw); }
    catch { throw new Error('INVALID_REWARD_ATTEMPT'); }
    const bumped = (fee: bigint) => fee + (fee + 9n) / 10n;
    if (old.type !== 'eip1559' || old.maxFeePerGas === undefined || old.maxPriorityFeePerGas === undefined
      || old.chainId !== transaction.chainId || old.to?.toLowerCase() !== transaction.to.toLowerCase()
      || old.data !== transaction.data || old.value !== transaction.value || old.gas !== transaction.gas
      || old.nonce !== transaction.nonce || transaction.maxFeePerGas < bumped(old.maxFeePerGas)
      || transaction.maxPriorityFeePerGas < bumped(old.maxPriorityFeePerGas)
      || await recoverTransactionAddress({ serializedTransaction: previousRaw as `0x02${string}` })
        !== await recoverTransactionAddress({ serializedTransaction: attempt.raw as `0x02${string}` })) {
      throw new Error('REWARD_ATTEMPT_CONFLICT');
    }
  }
  if (prior.some((item) => item.tx_hash.toLowerCase() === attempt.hash.toLowerCase())) {
    return prior.find((item) => item.tx_hash.toLowerCase() === attempt.hash.toLowerCase())!.attempt_no;
  }
  const next = prior.length + 1;
  const encrypted = await encryptRewardState(key, deploymentId, requestId, next, attempt.raw);
  return storage.transactionSync(() => {
    beforeWrite();
    const request = storage.sql.exec<{ status: string; operation_id: string | null }>(
      'SELECT status, operation_id FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
      deploymentId, requestId,
    ).toArray()[0];
    const draft = storage.sql.exec<{ phase: string }>(
      'SELECT phase FROM reward_drafts WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
    ).toArray()[0];
    if ((prior.length === 0 ? request?.status !== 'processing'
      : request?.status !== 'pending' && request?.status !== 'unknown')
      || request?.operation_id !== attempt.operationId
      || draft?.phase !== 'signature-started') throw new Error('REWARD_ATTEMPT_CONFLICT');
    const latest = storage.sql.exec<AttemptRow>(
      `SELECT attempt_no, operation_id, nonce, tx_hash, encrypted_raw, outer_status
       FROM reward_attempts WHERE deployment_id = ? AND request_id = ? ORDER BY attempt_no`,
      deploymentId, requestId,
    ).toArray();
    if (latest.some((item) => item.tx_hash.toLowerCase() === attempt.hash.toLowerCase())) {
      return latest.find((item) => item.tx_hash.toLowerCase() === attempt.hash.toLowerCase())!.attempt_no;
    }
    if (latest.length !== prior.length || latest.some((item) => item.operation_id !== attempt.operationId
      || item.nonce !== attempt.nonce)) throw new Error('REWARD_ATTEMPT_CONFLICT');
    storage.sql.exec(`INSERT INTO reward_attempts (deployment_id, request_id, attempt_no, kind,
      operation_id, nonce, tx_hash, encrypted_raw, outer_status)
      VALUES (?, ?, ?, 'distribution', ?, ?, ?, ?, 'stored')`,
    deploymentId, requestId, next, attempt.operationId, attempt.nonce, attempt.hash.toLowerCase(), encrypted);
    storage.sql.exec(`UPDATE reward_requests SET status = 'pending', state_version = state_version + 1
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    return next;
  });
}

export async function listRewardAttempts(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, key: Uint8Array): Promise<RewardAttempt[]> {
  const rows = storage.sql.exec<AttemptRow>(
    `SELECT attempt_no, operation_id, nonce, tx_hash, encrypted_raw, outer_status
     FROM reward_attempts WHERE deployment_id = ? AND request_id = ? ORDER BY attempt_no`,
    deploymentId, requestId,
  ).toArray();
  const result: RewardAttempt[] = [];
  for (const row of rows) {
    const raw = await decryptRewardState(key, deploymentId, requestId, row.attempt_no, row.encrypted_raw) as Hex;
    if (keccak256(raw).toLowerCase() !== row.tx_hash.toLowerCase()) throw new Error('INVALID_REWARD_ATTEMPT');
    result.push({ attemptNo: row.attempt_no, operationId: row.operation_id, nonce: row.nonce,
      hash: row.tx_hash as Hex, raw,
      outerStatus: row.outer_status as RewardAttempt['outerStatus'] });
  }
  return result;
}

/** Broadcasts only a previously saved raw; unknown RPC result remains unknown. */
export async function broadcastRewardAttempt(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, attemptNo: number, key: Uint8Array, rpc: RawRpc): Promise<void> {
  const attempts = await listRewardAttempts(storage, deploymentId, requestId, key);
  const attempt = attempts.find((item) => item.attemptNo === attemptNo);
  if (attempt === undefined) throw new Error('REWARD_ATTEMPT_CONFLICT');
  const request = storage.sql.exec<{ status: string; operation_id: string | null }>(
    'SELECT status, operation_id FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
    deploymentId, requestId,
  ).toArray()[0];
  if (request?.status !== 'pending' && request?.status !== 'unknown') throw new Error('REWARD_ATTEMPT_CONFLICT');
  if (request.operation_id !== attempt.operationId || attempts.some((item) => item.operationId !== attempt.operationId
    || item.nonce !== attempt.nonce)) throw new Error('REWARD_ATTEMPT_CONFLICT');
  const draft = storage.sql.exec<{ phase: string }>(
    'SELECT phase FROM reward_drafts WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
  ).toArray()[0];
  const inputs = storage.sql.exec<{ status: string }>(
    'SELECT status FROM reward_inputs WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
  ).toArray();
  const availability = storage.sql.exec<{ reason: string }>(
    'SELECT reason FROM reward_availability WHERE deployment_id = ?', deploymentId,
  ).toArray()[0];
  if (draft?.phase !== 'signature-started' || inputs.length === 0
    || inputs.some((input) => input.status !== 'reserved')
    || (availability !== undefined && availability.reason !== 'healthy')) {
    throw new Error('REWARD_ATTEMPT_CONFLICT');
  }
  let outerStatus: RewardAttempt['outerStatus'] = 'unknown';
  try {
    const reported = await rpc.sendRawTransaction({ serializedTransaction: attempt.raw });
    if (reported.toLowerCase() === attempt.hash.toLowerCase()) outerStatus = 'pending';
  } catch { /* Accepted broadcast with lost acknowledgement is still possible. */ }
  storage.sql.exec(`UPDATE reward_attempts SET outer_status = ?
    WHERE deployment_id = ? AND request_id = ? AND attempt_no = ?`,
  outerStatus, deploymentId, requestId, attemptNo);
}
