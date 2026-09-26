import { expect, it } from 'vitest';
import type { HistoryPort, ReceiptKeyPort } from '@confidential-utxo/core';
import { decryptRewardState, encryptRewardState, parseRewardSecrets, readRewardFunds } from '../src/rewards/crypto.js';

const key = new Uint8Array(32).fill(7);

it('binds encrypted state to deployment, request and revision', async () => {
  const ciphertext = await encryptRewardState(key, 'local-v1', 'request-1', 2, '{"secret":"value"}');
  expect(await decryptRewardState(key, 'local-v1', 'request-1', 2, ciphertext)).toBe('{"secret":"value"}');
  await expect(decryptRewardState(key, 'other', 'request-1', 2, ciphertext)).rejects.toThrow();
  await expect(decryptRewardState(key, 'local-v1', 'other', 2, ciphertext)).rejects.toThrow();
  await expect(decryptRewardState(key, 'local-v1', 'request-1', 3, ciphertext)).rejects.toThrow();
  const changed = ciphertext.slice(0, -2) + (ciphertext.endsWith('A') ? 'B' : 'A') + ciphertext.slice(-1);
  await expect(decryptRewardState(key, 'local-v1', 'request-1', 2, changed)).rejects.toThrow();
});

it('treats incomplete finalized history as unknown funds', async () => {
  const history = { getFinalizedCheckpoint: async () => null } as unknown as HistoryPort;
  const keys: ReceiptKeyPort = { getKey: async () => key };
  const result = await readRewardFunds(history, keys, `0x${'11'.repeat(20)}`);
  expect(result).toEqual({ status: 'unknown' });
});

it('loads source keys only from the selected deployment secret', () => {
  const source = JSON.stringify({ 'local-v1': {
    stateKey: `0x${'11'.repeat(32)}`, receiptKey: `0x${'22'.repeat(32)}`,
    ownerPrivateKey: `0x${'33'.repeat(32)}`,
  } });
  expect(parseRewardSecrets(source, 'local-v1')?.stateKey).toHaveLength(32);
  expect(parseRewardSecrets(source, 'other')).toBeUndefined();
  expect(parseRewardSecrets('{broken', 'local-v1')).toBeUndefined();
});
