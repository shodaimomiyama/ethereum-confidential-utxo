import type { RewardRecord, RewardStatus, Scope, RequestId, SignedRecipientInfo, AttemptId, TxHash } from '@confidential-utxo/uniswap';
import type { RewardRequest } from '@confidential-utxo/uniswap';
import { keccak256, stringToHex } from 'viem';
import { decodeRewardSecret, decryptRewardState, encodeRewardSecret, encryptRewardState } from './crypto.js';
import { authorizeOperation, buildOperation } from '@confidential-utxo/core';
import type { BuildIntent, Context, LocalDraft, OwnedUtxo, SignerPort } from '@confidential-utxo/core';

type RewardRow = {
  deployment_id: string;
  owner: string;
  request_id: string;
  amount_wei: string;
  recipient_info_json: string;
  status: string;
  operation_id: string | null;
  checkpoint_hash: string | null;
  output_id: string | null;
};

function record(storage: DurableObjectStorage, row: RewardRow): RewardRecord {
  const attempts = storage.sql.exec<{ attempt_no: number; tx_hash: string }>(
    `SELECT attempt_no, tx_hash FROM reward_attempts WHERE deployment_id = ? AND request_id = ?
     ORDER BY attempt_no`, row.deployment_id, row.request_id,
  ).toArray();
  return {
    scope: { deploymentId: row.deployment_id, owner: row.owner } as Scope,
    requestId: row.request_id as RequestId,
    amountWei: BigInt(row.amount_wei),
    recipientInfo: JSON.parse(row.recipient_info_json) as SignedRecipientInfo,
    status: row.status as RewardStatus,
    attemptIds: attempts.map((item) => `${row.request_id}:${item.attempt_no}` as AttemptId),
    txHashes: attempts.map((item) => item.tx_hash as TxHash),
    ...(row.operation_id === null ? {} : { operationId: row.operation_id as RewardRecord['operationId'] }),
    ...(row.checkpoint_hash === null ? {} : { blockHash: row.checkpoint_hash as RewardRecord['blockHash'] }),
    ...(row.output_id === null ? {} : { outputId: row.output_id as RewardRecord['outputId'] }),
  };
}

export function listRewards(storage: DurableObjectStorage, scope: Scope): RewardRecord[] {
  return storage.sql.exec<RewardRow>(
    `SELECT deployment_id, owner, request_id, amount_wei, recipient_info_json, status,
      operation_id, checkpoint_hash, output_id FROM reward_requests
      WHERE deployment_id = ? AND owner = ? ORDER BY seq`,
    scope.deploymentId, scope.owner.toLowerCase(),
  ).toArray().map((row) => record(storage, row));
}

export function getReward(storage: DurableObjectStorage, scope: Scope, requestId: string): RewardRecord | undefined {
  const row = storage.sql.exec<RewardRow>(
    `SELECT deployment_id, owner, request_id, amount_wei, recipient_info_json, status,
      operation_id, checkpoint_hash, output_id FROM reward_requests
      WHERE deployment_id = ? AND owner = ? AND request_id = ?`,
    scope.deploymentId, scope.owner.toLowerCase(), requestId.toLowerCase(),
  ).toArray()[0];
  return row === undefined ? undefined : record(storage, row);
}

export type Admission =
  | { kind: 'accepted' | 'same'; record: RewardRecord }
  | { kind: 'pending'; record: RewardRecord }
  | { kind: 'insufficient' }
  | { kind: 'unknown' };

function rewardContentHash(request: RewardRequest): string {
  return keccak256(stringToHex(JSON.stringify([
    request.scope.deploymentId,
    request.scope.owner.toLowerCase(),
    request.amountWei.toString(),
    request.recipientInfo.owner.toLowerCase(),
    request.recipientInfo.publicKey.toLowerCase(),
    request.recipientInfo.signature.toLowerCase(),
  ])));
}

/** `confirmedTotalWei` is the observed finalized pool balance before subtracting active reservations. */
export function admitReward(
  storage: DurableObjectStorage, request: RewardRequest, confirmedTotalWei?: bigint,
): Admission {
  return storage.transactionSync(() => {
    const existing = storage.sql.exec<{ content_hash: string }>(
      'SELECT content_hash FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
      request.scope.deploymentId, request.requestId.toLowerCase(),
    ).toArray()[0];
    const contentHash = rewardContentHash(request);
    if (existing !== undefined) {
      if (existing.content_hash !== contentHash) throw new Error('REQUEST_CONFLICT');
      const record = getReward(storage, request.scope, request.requestId);
      if (record === undefined) throw new Error('REQUEST_CONFLICT');
      return { kind: 'same', record };
    }
    const pending = storage.sql.exec<{ request_id: string }>(
      `SELECT request_id FROM reward_requests WHERE deployment_id = ? AND owner = ?
       AND status NOT IN ('received', 'ended-without-distribution') ORDER BY seq LIMIT 1`,
      request.scope.deploymentId, request.scope.owner.toLowerCase(),
    ).toArray()[0];
    if (pending !== undefined) {
      const record = getReward(storage, request.scope, pending.request_id);
      if (record === undefined) throw new Error('SERVICE_UNAVAILABLE');
      return { kind: 'pending', record };
    }
    if (confirmedTotalWei === undefined) return { kind: 'unknown' };
    const active = storage.sql.exec<{ amount_wei: string }>(
      'SELECT amount_wei FROM reward_reservations WHERE deployment_id = ? AND released = 0',
      request.scope.deploymentId,
    ).toArray().reduce((total, row) => total + BigInt(row.amount_wei), 0n);
    if (confirmedTotalWei < active + request.amountWei) return { kind: 'insufficient' };
    storage.sql.exec(
      `INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
       recipient_info_json, content_hash, status) VALUES (?, ?, ?, ?, ?, ?, 'accepted')`,
      request.scope.deploymentId, request.scope.owner.toLowerCase(), request.requestId.toLowerCase(),
      request.amountWei.toString(), JSON.stringify(request.recipientInfo), contentHash,
    );
    storage.sql.exec(
      'INSERT INTO reward_reservations (deployment_id, request_id, amount_wei) VALUES (?, ?, ?)',
      request.scope.deploymentId, request.requestId.toLowerCase(), request.amountWei.toString(),
    );
    const record = getReward(storage, request.scope, request.requestId);
    if (record === undefined) throw new Error('SERVICE_UNAVAILABLE');
    return { kind: 'accepted', record };
  });
}

export type RewardWork = { revision: number; phase: 'claimed' | 'draft-saved' | 'signature-started' };

/** A claim is deliberately not leased: a crash during random draft generation requires explicit operator resolution. */
export function claimRewardWork(storage: DurableObjectStorage, deploymentId: string, requestId: string): RewardWork | undefined {
  return storage.transactionSync(() => {
    const request = storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
    ).toArray()[0];
    if (request?.status !== 'accepted') return undefined;
    const existing = storage.sql.exec<{ phase: string }>(
      'SELECT phase FROM reward_drafts WHERE deployment_id = ? AND request_id = ?', deploymentId, requestId,
    ).toArray()[0];
    if (existing !== undefined) return undefined;
    storage.sql.exec(`INSERT INTO reward_drafts (deployment_id, request_id, phase, version)
      VALUES (?, ?, 'claimed', 1)`, deploymentId, requestId);
    storage.sql.exec(`UPDATE reward_requests SET status = 'processing', state_version = state_version + 1
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    return { revision: 1, phase: 'claimed' };
  });
}

export async function saveDraftIfCurrent<T extends { operationId: string; request: { inputIds: readonly string[] } }>(
  storage: DurableObjectStorage, deploymentId: string, requestId: string, revision: number,
  key: Uint8Array, draft: T,
): Promise<boolean> {
  const encrypted = await encryptRewardState(key, deploymentId, requestId, revision, encodeRewardSecret(draft));
  return storage.transactionSync(() => {
    const current = storage.sql.exec<{ phase: string; version: number; status: string }>(
      `SELECT d.phase, d.version, r.status FROM reward_drafts d JOIN reward_requests r
       ON r.deployment_id = d.deployment_id AND r.request_id = d.request_id
       WHERE d.deployment_id = ? AND d.request_id = ?`,
      deploymentId, requestId,
    ).toArray()[0];
    if (current?.phase !== 'claimed' || current.version !== revision || current.status !== 'processing') return false;
    if (new Set(draft.request.inputIds.map((id) => id.toLowerCase())).size !== draft.request.inputIds.length) {
      throw new Error('REWARD_INPUT_CONFLICT');
    }
    for (const inputId of draft.request.inputIds) {
      storage.sql.exec(`INSERT INTO reward_inputs (deployment_id, input_id, request_id, status)
        VALUES (?, ?, ?, 'reserved')`, deploymentId, inputId.toLowerCase(), requestId);
    }
    storage.sql.exec(`UPDATE reward_drafts SET phase = 'draft-saved', encrypted_json = ?
      WHERE deployment_id = ? AND request_id = ? AND phase = 'claimed' AND version = ?`,
    encrypted, deploymentId, requestId, revision);
    storage.sql.exec(`UPDATE reward_requests SET operation_id = ?, state_version = state_version + 1
      WHERE deployment_id = ? AND request_id = ? AND status = 'processing'`,
    draft.operationId, deploymentId, requestId);
    return true;
  });
}

export async function loadSavedDraft<T extends { operationId: string }>(
  storage: DurableObjectStorage, deploymentId: string, requestId: string, key: Uint8Array,
): Promise<T | undefined> {
  const row = storage.sql.exec<{ phase: string; version: number; encrypted_json: string | null; operation_id: string | null }>(
    `SELECT d.phase, d.version, d.encrypted_json, r.operation_id FROM reward_drafts d
      JOIN reward_requests r ON r.deployment_id = d.deployment_id AND r.request_id = d.request_id
      WHERE d.deployment_id = ? AND d.request_id = ?`, deploymentId, requestId,
  ).toArray()[0];
  if (row === undefined || row.phase === 'claimed' || row.encrypted_json === null) return undefined;
  const decoded = decodeRewardSecret<T>(await decryptRewardState(key, deploymentId, requestId,
    row.version, row.encrypted_json));
  if (decoded.operationId !== row.operation_id) throw new Error('INVALID_REWARD_STATE');
  return decoded;
}

/** Persist the signing boundary before any signer is called. */
export function markSignatureStarted(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, revision: number): boolean {
  return storage.transactionSync(() => {
    const current = storage.sql.exec<{ phase: string; version: number; status: string }>(
      `SELECT d.phase, d.version, r.status FROM reward_drafts d JOIN reward_requests r
       ON r.deployment_id = d.deployment_id AND r.request_id = d.request_id
       WHERE d.deployment_id = ? AND d.request_id = ?`,
      deploymentId, requestId,
    ).toArray()[0];
    if (current?.phase !== 'draft-saved' || current.version !== revision || current.status !== 'processing') return false;
    storage.sql.exec(`UPDATE reward_drafts SET phase = 'signature-started'
      WHERE deployment_id = ? AND request_id = ? AND version = ?`, deploymentId, requestId, revision);
    storage.sql.exec(`UPDATE reward_requests SET state_version = state_version + 1
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    return true;
  });
}

export async function saveAuthorizedDraftIfCurrent(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, revision: number, key: Uint8Array, draft: LocalDraft): Promise<boolean> {
  if (draft.signature === undefined) return false;
  const encrypted = await encryptRewardState(key, deploymentId, requestId, revision, encodeRewardSecret(draft));
  return storage.transactionSync(() => {
    const row = storage.sql.exec<{ phase: string; version: number; operation_id: string | null; status: string }>(
      `SELECT d.phase, d.version, r.operation_id, r.status FROM reward_drafts d JOIN reward_requests r
       ON r.deployment_id = d.deployment_id AND r.request_id = d.request_id
       WHERE d.deployment_id = ? AND d.request_id = ?`, deploymentId, requestId,
    ).toArray()[0];
    if (row?.phase !== 'signature-started' || row.version !== revision
      || row.operation_id !== draft.operationId || row.status !== 'processing') return false;
    storage.sql.exec(`UPDATE reward_drafts SET encrypted_json = ?
      WHERE deployment_id = ? AND request_id = ? AND version = ?`, encrypted, deploymentId, requestId, revision);
    storage.sql.exec(`UPDATE reward_requests SET state_version = state_version + 1
      WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
    return true;
  });
}

/** A failed build leaves a claimed marker; its random packet is never regenerated automatically. */
export async function buildAndAuthorizeReward(
  storage: DurableObjectStorage, deploymentId: string, requestId: string, key: Uint8Array,
  intent: BuildIntent, context: Context, inputs: OwnedUtxo[], signer: SignerPort,
): Promise<LocalDraft | undefined> {
  const claim = claimRewardWork(storage, deploymentId, requestId);
  if (claim === undefined) return undefined;
  const draft = await buildOperation(intent, context, { inputs, randomSalt: () => crypto.getRandomValues(new Uint8Array(32)) });
  if (!await saveDraftIfCurrent(storage, deploymentId, requestId, claim.revision, key, draft)) {
    throw new Error('REWARD_DRAFT_CONFLICT');
  }
  if (!markSignatureStarted(storage, deploymentId, requestId, claim.revision)) {
    throw new Error('REWARD_DRAFT_CONFLICT');
  }
  const signature = await authorizeOperation(context, draft.request, signer);
  const signed: LocalDraft = { ...draft, signature };
  if (!await saveAuthorizedDraftIfCurrent(storage, deploymentId, requestId, claim.revision, key, signed)) {
    throw new Error('REWARD_DRAFT_CONFLICT');
  }
  return signed;
}
