import { keccak256 } from 'viem';
import type { Hex } from 'viem';
import { bytesToHex } from 'viem';
import { x25519 } from '@noble/curves/ed25519.js';
import { M } from '@confidential-utxo/crypto';
import { buildOperation, recipientInfoTypedData } from '@confidential-utxo/core';
import type { Context, OwnedUtxo } from '@confidential-utxo/core';
import type { privateKeyToAccount } from 'viem/accounts';
import { decodeRewardSecret, decryptRewardState, encodeRewardSecret, encryptRewardState } from './crypto.js';

type ConsolidationDraft = { operationId: string; signature?: string };

export async function buildConsolidationDraft(context: Context,
  account: ReturnType<typeof privateKeyToAccount>, receiptKey: Uint8Array,
  available: OwnedUtxo[]): Promise<{ operationId: string; inputIds: string[];
    draft: Awaited<ReturnType<typeof buildOperation>> }> {
  if (available.length < 2) throw new Error('CONSOLIDATION_INPUTS_UNKNOWN');
  const pair = [...available].sort((a, b) => a.opening.amount > b.opening.amount ? -1
    : a.opening.amount < b.opening.amount ? 1 : a.id.localeCompare(b.id)).slice(0, 2);
  const sum = pair[0]!.opening.amount + pair[1]!.opening.amount;
  const unsigned = { chainId: context.chainId, pool: context.pool, owner: account.address,
    receivePublicKey: bytesToHex(x25519.getPublicKey(receiptKey)),
    receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
  const signature = await account.signTypedData(recipientInfoTypedData(context, unsigned, account.address));
  const recipient = { ...unsigned, signature };
  const draft = await buildOperation({ kind: 1, owner: account.address,
    amount: sum > M ? M : sum, recipient, changeRecipient: recipient,
    explicitIds: pair.map((coin) => coin.id) }, context,
  { inputs: pair, randomSalt: () => crypto.getRandomValues(new Uint8Array(32)) });
  return { operationId: draft.operationId, inputIds: pair.map((coin) => coin.id), draft };
}
export type ConsolidationPorts = {
  build(): Promise<{ operationId: string; inputIds: string[]; draft: ConsolidationDraft }>;
  sign(draft: ConsolidationDraft): Promise<ConsolidationDraft>;
  prepare(draft: ConsolidationDraft): Promise<{ raw: Hex; hash: Hex; nonce: number }>;
  observe(operationId: string, inputIds: string[]): Promise<'unknown' | 'none'
    | { kind: 'finalized'; checkpointHash: string }>;
  broadcast(raw: Hex): Promise<void>;
};

type Row = { round: number; phase: string; operation_id: string | null;
  input_ids_json: string | null; encrypted_draft: string | null; encrypted_raw: string | null;
  tx_hash: string | null; checkpoint_hash: string | null };

export function latestConsolidation(storage: DurableObjectStorage, deploymentId: string,
  requestId: string): Row | undefined {
  return storage.sql.exec<Row>(`SELECT round, phase, operation_id, input_ids_json,
    encrypted_draft, encrypted_raw, tx_hash, checkpoint_hash FROM reward_consolidations
    WHERE deployment_id = ? AND request_id = ? ORDER BY round DESC LIMIT 1`,
  deploymentId, requestId).toArray()[0];
}

/** A consolidation is its own Pool operation; every restart resumes its saved phase. */
export async function advanceRewardConsolidation(storage: DurableObjectStorage, deploymentId: string,
  requestId: string, key: Uint8Array, ports: ConsolidationPorts,
  startNewRound = false, beforeWrite: () => void = () => {}): Promise<boolean> {
  let row = latestConsolidation(storage, deploymentId, requestId);
  if (row?.phase === 'finalized' && !startNewRound) return true;
  let created = false;
  if (row === undefined || row.phase === 'finalized') {
    const round = (row?.round ?? 0) + 1;
    storage.transactionSync(() => {
      beforeWrite();
      const request = storage.sql.exec<{ status: string }>(
        'SELECT status FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
        deploymentId, requestId).toArray()[0];
      if (request?.status !== 'accepted') throw new Error('CONSOLIDATION_CONFLICT');
      storage.sql.exec(`INSERT INTO reward_consolidations (deployment_id, request_id, round, phase)
        VALUES (?, ?, ?, 'claimed')`, deploymentId, requestId, round);
    });
    row = latestConsolidation(storage, deploymentId, requestId)!;
    created = true;
  }
  const round = row.round;
  if (row.phase === 'claimed') {
    if (!created) throw new Error('CONSOLIDATION_BUILD_INTERRUPTED');
    const built = await ports.build();
    if (built.inputIds.length !== 2 || built.operationId !== built.draft.operationId) {
      throw new Error('CONSOLIDATION_CONFLICT');
    }
    const encrypted = await encryptRewardState(key, deploymentId, requestId, round,
      encodeRewardSecret(built.draft));
    storage.transactionSync(() => {
      beforeWrite();
      const request = storage.sql.exec<{ status: string }>(
        'SELECT status FROM reward_requests WHERE deployment_id = ? AND request_id = ?',
        deploymentId, requestId).toArray()[0];
      if (request?.status !== 'accepted') throw new Error('CONSOLIDATION_CONFLICT');
      storage.sql.exec(`UPDATE reward_consolidations SET phase = 'draft-saved', operation_id = ?,
        input_ids_json = ?, encrypted_draft = ? WHERE deployment_id = ? AND request_id = ?
        AND round = ? AND phase = 'claimed'`, built.operationId, JSON.stringify(built.inputIds),
      encrypted, deploymentId, requestId, round);
    });
    row = latestConsolidation(storage, deploymentId, requestId)!;
  }
  if (row.phase === 'draft-saved') {
    beforeWrite();
    storage.sql.exec(`UPDATE reward_consolidations SET phase = 'signature-started'
      WHERE deployment_id = ? AND request_id = ? AND round = ? AND phase = 'draft-saved'`,
    deploymentId, requestId, round);
    row = latestConsolidation(storage, deploymentId, requestId)!;
  }
  if (row.phase === 'signature-started') {
    if (row.encrypted_draft === null) throw new Error('CONSOLIDATION_CONFLICT');
    const draft = decodeRewardSecret<ConsolidationDraft>(await decryptRewardState(key, deploymentId,
      requestId, round, row.encrypted_draft));
    if (draft.operationId !== row.operation_id) throw new Error('CONSOLIDATION_CONFLICT');
    // A lost signer acknowledgement is ambiguous. A persisted signed draft resumes below.
    if (draft.signature === undefined) {
      beforeWrite();
      const signed = await ports.sign(draft);
      if (signed.operationId !== row.operation_id || signed.signature === undefined) {
        throw new Error('CONSOLIDATION_CONFLICT');
      }
      const encrypted = await encryptRewardState(key, deploymentId, requestId, round,
        encodeRewardSecret(signed));
      storage.sql.exec(`UPDATE reward_consolidations SET encrypted_draft = ?
        WHERE deployment_id = ? AND request_id = ? AND round = ? AND phase = 'signature-started'`,
      encrypted, deploymentId, requestId, round);
    }
    row = latestConsolidation(storage, deploymentId, requestId)!;
    const signed = decodeRewardSecret<ConsolidationDraft>(await decryptRewardState(key, deploymentId,
      requestId, round, row.encrypted_draft!));
    if (signed.signature === undefined) throw new Error('CONSOLIDATION_SIGNATURE_UNKNOWN');
    beforeWrite();
    const prepared = await ports.prepare(signed);
    if (keccak256(prepared.raw).toLowerCase() !== prepared.hash.toLowerCase()
      || !Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) throw new Error('CONSOLIDATION_CONFLICT');
    const encryptedRaw = await encryptRewardState(key, deploymentId, requestId, round + 1_000_000,
      prepared.raw);
    beforeWrite();
    storage.sql.exec(`UPDATE reward_consolidations SET phase = 'raw-saved', encrypted_raw = ?,
      tx_hash = ?, nonce = ? WHERE deployment_id = ? AND request_id = ? AND round = ?
      AND phase = 'signature-started'`, encryptedRaw, prepared.hash, prepared.nonce,
    deploymentId, requestId, round);
    row = latestConsolidation(storage, deploymentId, requestId)!;
  }
  if (row.phase !== 'raw-saved' || row.operation_id === null || row.input_ids_json === null
    || row.encrypted_raw === null || row.tx_hash === null) throw new Error('CONSOLIDATION_CONFLICT');
  const inputs = JSON.parse(row.input_ids_json) as string[];
  const observed = await ports.observe(row.operation_id, inputs);
  if (observed === 'unknown') throw new Error('REWARD_FUNDS_UNKNOWN');
  if (typeof observed === 'object' && observed.kind === 'finalized') {
    storage.sql.exec(`UPDATE reward_consolidations SET phase = 'finalized', checkpoint_hash = ?
      WHERE deployment_id = ? AND request_id = ? AND round = ? AND phase = 'raw-saved'`,
    observed.checkpointHash, deploymentId, requestId, round);
    return true;
  }
  if (observed === 'none') {
    beforeWrite();
    const raw = await decryptRewardState(key, deploymentId, requestId, round + 1_000_000,
      row.encrypted_raw) as Hex;
    if (keccak256(raw).toLowerCase() !== row.tx_hash.toLowerCase()) throw new Error('CONSOLIDATION_CONFLICT');
    await ports.broadcast(raw);
  }
  return false;
}
