import { expect, it } from 'vitest';
import type { Bytes32, Scope } from '@confidential-utxo/uniswap';
import { createIndexedDbCipherCache } from '../../src/live/cache.js';
const scope = { deploymentId: 'sepolia-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const recordId = `0x${'22'.repeat(32)}` as Bytes32;
it('treats unavailable IndexedDB as an optional cache miss', async () => {
  const cache = createIndexedDbCipherCache(null);
  expect(await cache.read(scope, recordId)).toBeUndefined();
  await expect(cache.write(scope, recordId, { recordId, revision: 1,
    encryptedBundle: { nonce: `0x${'00'.repeat(12)}`, ciphertext: 'AQ==', tag: `0x${'00'.repeat(16)}` }, updatedAt: 1 })).resolves.toBeUndefined();
});
