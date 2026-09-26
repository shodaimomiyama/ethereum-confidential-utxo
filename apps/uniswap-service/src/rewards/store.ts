import type { RewardRecord, RewardStatus, Scope, RequestId, SignedRecipientInfo } from '@confidential-utxo/uniswap';
import type { RewardRequest } from '@confidential-utxo/uniswap';
import { keccak256, stringToHex } from 'viem';

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

function record(row: RewardRow): RewardRecord {
  return {
    scope: { deploymentId: row.deployment_id, owner: row.owner } as Scope,
    requestId: row.request_id as RequestId,
    amountWei: BigInt(row.amount_wei),
    recipientInfo: JSON.parse(row.recipient_info_json) as SignedRecipientInfo,
    status: row.status as RewardStatus,
    attemptIds: [],
    txHashes: [],
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
  ).toArray().map(record);
}

export function getReward(storage: DurableObjectStorage, scope: Scope, requestId: string): RewardRecord | undefined {
  const row = storage.sql.exec<RewardRow>(
    `SELECT deployment_id, owner, request_id, amount_wei, recipient_info_json, status,
      operation_id, checkpoint_hash, output_id FROM reward_requests
      WHERE deployment_id = ? AND owner = ? AND request_id = ?`,
    scope.deploymentId, scope.owner.toLowerCase(), requestId.toLowerCase(),
  ).toArray()[0];
  return row === undefined ? undefined : record(row);
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
