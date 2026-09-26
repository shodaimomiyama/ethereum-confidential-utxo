import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { CryptoWorkerClient } from '../../src/live/worker-client.js';
import rangeVectors from '../../../../tests/vectors/cases/range-deterministic.json' with { type: 'json' };
import balanceVectors from '../../../../tests/vectors/cases/balance.json' with { type: 'json' };
import hpkeVectors from '../../../../tests/vectors/cases/hpke.json' with { type: 'json' };
const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.slice(2).match(/../g)!, x => parseInt(x, 16));
const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
async function client(): Promise<CryptoWorkerClient> {
  const path = '/worker-bundle/worker-client.js';
  const bundle: typeof import('../../src/live/worker-client.js') = await import(/* @vite-ignore */ path);
  return new bundle.CryptoWorkerClient();
}
it('imports the public crypto entry point with no Node Buffer', async () => {
  expect('Buffer' in globalThis).toBe(false);
  const core = await import('@confidential-utxo/crypto');
  expect(core.commit({ amount: 1n, blinding: 0n }).x).toBeGreaterThan(0n);
});
it('runs the production Worker bundle with range/balance vector inputs and secure randomness', async () => {
  const worker = await client();
  const range = rangeVectors[0]!.input;
  const balance = balanceVectors[0]!;
  const { balanceWitness } = await import('@confidential-utxo/crypto');
  const started = performance.now();
  try {
    const result = await worker.run({ kind: 'prove', jobId: 'proof', epoch: 0, scope, payload: {
      range: [{ amount: BigInt(range.amount), blinding: BigInt(range.blinding) }, bytes(range.operationId), BigInt(range.outputIndex)],
      balance: { X: { x: BigInt(balance.expected.X![0]!), y: BigInt(balance.expected.X![1]!) },
        x: balanceWitness([], balance.input.outputOpenings!.map(opening => BigInt(opening.blinding))), chainId: BigInt(balance.input.chainId!), pool: bytes(balance.input.pool!), operationId: bytes(balance.input.operationId!) },
    } });
    expect(result.jobKind).toBe('prove');
    if (result.jobKind !== 'prove') throw new Error('wrong result kind');
    expect(result.value.range.coords.slice(0, 2)).toEqual(range.coords.slice(0, 2).map(BigInt));
    expect(result.value.range.coords).toHaveLength(10); expect(result.value.range.scalars).toHaveLength(5);
    expect(result.value.range.ls).toHaveLength(12); expect(result.value.range.rs).toHaveLength(12);
    expect(result.value.balance.Rx).toBeTypeOf('bigint'); expect(result.value.balance.s).toBeGreaterThan(0n);
    expect(Object.keys(result).sort()).toEqual(['epoch', 'jobId', 'jobKind', 'kind', 'scope', 'value']);
    console.info(`Worker proof elapsed: ${(performance.now() - started).toFixed(0)} ms; ${navigator.userAgent}`);
  } finally { worker.dispose(); }
});
it('decrypts a known HPKE vector and returns only the opening; tampering returns a sanitized error', async () => {
  const worker = await client(); const vector = hpkeVectors.find(v => v.id === 'VEC-07-RECEIPT-VALID')!.input;
  const payload = { recipientPrivateKey: bytes(vector.recipientPrivateKey!), info: bytes(vector.info), packet: bytes(vector.packet!),
    commitment: { x: BigInt(vector.Cx!), y: BigInt(vector.Cy!) } };
  try {
    const result = await worker.run({ kind: 'receive', jobId: 'receipt', epoch: 0, scope, payload });
    expect(result).toEqual({ kind: 'result', jobKind: 'receive', jobId: 'receipt', epoch: 0, scope, value: { amount: 1n, blinding: 0n } });
    payload.packet[45] = payload.packet[45]! ^ 1;
    await expect(worker.run({ kind: 'receive', jobId: 'bad', epoch: 0, scope, payload })).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  } finally { payload.recipientPrivateKey.fill(0); worker.dispose(); }
});
