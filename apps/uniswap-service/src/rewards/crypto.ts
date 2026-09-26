import { synchronize } from '@confidential-utxo/core';
import type { Checkpoint, HistoryPort, OwnedUtxo, ReceiptKeyPort } from '@confidential-utxo/core';
import { bytesToHex, hexToBytes } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function additionalData(deploymentId: string, requestId: string, version: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('INVALID_REWARD_STATE');
  return ownedBytes(new TextEncoder().encode(JSON.stringify([deploymentId, requestId, version])));
}

async function importStateKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('INVALID_REWARD_STATE');
  return crypto.subtle.importKey('raw', ownedBytes(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptRewardState(key: Uint8Array, deploymentId: string,
  requestId: string, version: number, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: additionalData(deploymentId, requestId, version),
  }, await importStateKey(key), new TextEncoder().encode(plaintext)));
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return bytesToHex(combined);
}

export async function decryptRewardState(key: Uint8Array, deploymentId: string,
  requestId: string, version: number, ciphertext: string): Promise<string> {
  try {
    const bytes = hexToBytes(ciphertext as `0x${string}`);
    if (bytes.length < 29) throw new Error('INVALID_REWARD_STATE');
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(0, 12),
      additionalData: additionalData(deploymentId, requestId, version),
    }, await importStateKey(key), bytes.slice(12));
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch { throw new Error('INVALID_REWARD_STATE'); }
}

export function encodeRewardSecret(value: unknown): string {
  return JSON.stringify(value, (_name, part: unknown) => typeof part === 'bigint'
    ? { __rewardBigint: part.toString() } : part);
}

export function decodeRewardSecret<T>(source: string): T {
  return JSON.parse(source, (_name, part: unknown) => {
    if (part !== null && typeof part === 'object' && !Array.isArray(part)
      && Object.keys(part).length === 1 && typeof (part as Record<string, unknown>).__rewardBigint === 'string') {
      return BigInt((part as { __rewardBigint: string }).__rewardBigint);
    }
    return part;
  }) as T;
}

export type RewardFunds =
  | { status: 'complete'; available: OwnedUtxo[]; checkpoint: Checkpoint }
  | { status: 'unknown' };

export type RewardSecrets = {
  readonly stateKey: Uint8Array;
  readonly receiptKey: Uint8Array;
  readonly ownerPrivateKey: `0x${string}`;
  readonly owner: Address;
};

/** Parses a Worker Secret; never persist or log the source JSON. */
export function parseRewardSecrets(source: string | undefined, deploymentId: string): RewardSecrets | undefined {
  try {
    if (source === undefined) return undefined;
    const catalog: unknown = JSON.parse(source);
    if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)
      || !Object.hasOwn(catalog, deploymentId)) return undefined;
    const entry = (catalog as Record<string, unknown>)[deploymentId];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const { stateKey, receiptKey, ownerPrivateKey } = entry as Record<string, unknown>;
    if (![stateKey, receiptKey, ownerPrivateKey].every(
      (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) return undefined;
    const signingKey = ownerPrivateKey as `0x${string}`;
    return { stateKey: hexToBytes(stateKey as `0x${string}`), receiptKey: hexToBytes(receiptKey as `0x${string}`),
      ownerPrivateKey: signingKey, owner: privateKeyToAccount(signingKey).address };
  } catch { return undefined; }
}

/** Rebuilds spendable balance from finalized, canonical Pool history. */
export async function readRewardFunds(history: HistoryPort, keys: ReceiptKeyPort, owner: string): Promise<RewardFunds> {
  try {
    const checkpoint = await history.getFinalizedCheckpoint();
    if (checkpoint === null) return { status: 'unknown' };
    const observed = await history.getContext(checkpoint);
    if (!observed.complete || observed.blockHash.toLowerCase() !== checkpoint.hash.toLowerCase()) {
      return { status: 'unknown' };
    }
    const result = await synchronize(observed.value, { history, keys, owners: [owner as Address] });
    if (result.status !== 'complete' || result.receiptFailures.length !== 0
      || result.checkpoint.hash.toLowerCase() !== checkpoint.hash.toLowerCase()) {
      return { status: 'unknown' };
    }
    return { status: 'complete', available: result.utxos.filter((coin) => coin.status === 'available'),
      checkpoint: result.checkpoint };
  } catch { return { status: 'unknown' }; }
}
