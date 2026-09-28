import { expect, it, vi } from 'vitest';
import type { Address } from '@confidential-utxo/uniswap';
import { createWorkerReceiptKeyPort } from '../../src/live/receipt-worker.js';
import { CryptoWorkerError } from '../../src/live/worker-client.js';
import type { OperationContext } from '../../src/live/operations.js';

const owner = `0x${'11'.repeat(20)}` as Address;
const scope = { deploymentId: 'local-v1' as never, owner };
const input = { info: new Uint8Array(32).fill(1), packet: new Uint8Array(112).fill(2),
  commitment: { x: 1n, y: 2n } };

function fixture(run: (job: { readonly kind: string; readonly jobId: string; readonly payload: {
  readonly recipientPrivateKey: Uint8Array; readonly info: Uint8Array; readonly packet: Uint8Array;
} }) => Promise<unknown>) {
  const privateCopy = new Uint8Array(32).fill(7);
  const readKey = vi.fn(() => privateCopy);
  const runCrypto = vi.fn(run);
  const context = { scope, epoch: 4, check: () => {}, recipientPrivateKeyForWorker: readKey,
    runCrypto } as unknown as OperationContext;
  return { context, privateCopy, readKey, runCrypto };
}

it('opens a receipt in the Worker and clears the copied private key', async () => {
  let workerKeyByte: number | undefined;
  const f = fixture(async job => {
    workerKeyByte = job.payload.recipientPrivateKey[0];
    return { kind: 'result', jobKind: 'receive', jobId: job.jobId,
      scope, epoch: 4, value: { amount: 9n, blinding: 3n } };
  });
  const keys = createWorkerReceiptKeyPort(f.context);
  expect(keys.getKey).toBeUndefined();
  expect(keys.getKeys).toBeUndefined();
  await expect(keys.openReceipt!(owner, input)).resolves.toEqual({ status: 'opened', opening: { amount: 9n, blinding: 3n } });
  expect(f.runCrypto).toHaveBeenCalledWith(expect.objectContaining({ kind: 'receive',
    payload: { recipientPrivateKey: f.privateCopy, info: input.info, packet: input.packet, commitment: input.commitment } }));
  expect(workerKeyByte).toBe(7);
  expect(f.privateCopy.every(byte => byte === 0)).toBe(true);
});

it('does not read key material for another owner', async () => {
  const f = fixture(async () => { throw new Error('unexpected worker call'); });
  const keys = createWorkerReceiptKeyPort(f.context);
  await expect(keys.openReceipt!(`0x${'22'.repeat(20)}` as Address, input)).resolves.toEqual({ status: 'unavailable' });
  expect(f.readKey).not.toHaveBeenCalled();
  expect(f.runCrypto).not.toHaveBeenCalled();
});

it('classifies Worker cryptographic failure as invalid and clears the copied key', async () => {
  const f = fixture(async () => { throw new CryptoWorkerError('CRYPTO_FAILED'); });
  const keys = createWorkerReceiptKeyPort(f.context);
  await expect(keys.openReceipt!(owner, input)).resolves.toEqual({ status: 'invalid' });
  expect(f.privateCopy.every(byte => byte === 0)).toBe(true);
});

it('classifies Worker outage and mismatched reply identity as unavailable', async () => {
  const outage = fixture(async () => { throw new CryptoWorkerError('WORKER_UNAVAILABLE'); });
  await expect(createWorkerReceiptKeyPort(outage.context).openReceipt!(owner, input)).resolves.toEqual({ status: 'unavailable' });
  expect(outage.privateCopy.every(byte => byte === 0)).toBe(true);
  const wrong = fixture(async job => ({ kind: 'result', jobKind: 'receive', jobId: job.jobId,
    scope: { ...scope, owner: `0x${'22'.repeat(20)}` }, epoch: 4, value: { amount: 9n, blinding: 3n } }));
  await expect(createWorkerReceiptKeyPort(wrong.context).openReceipt!(owner, input)).resolves.toEqual({ status: 'unavailable' });
  expect(wrong.privateCopy.every(byte => byte === 0)).toBe(true);
});

it('treats malformed key material as unavailable without starting a Worker job', async () => {
  const f = fixture(async () => { throw new Error('unexpected worker call'); });
  const context = { ...f.context, recipientPrivateKeyForWorker: () => ({}) } as unknown as OperationContext;
  await expect(createWorkerReceiptKeyPort(context).openReceipt!(owner, input)).resolves.toEqual({ status: 'unavailable' });
  expect(f.runCrypto).not.toHaveBeenCalled();
});
