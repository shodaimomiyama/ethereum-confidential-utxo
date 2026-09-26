import { generateRangeProof, generateBalanceProof, decryptReceipt } from '@confidential-utxo/crypto';
import type { CryptoJob, CryptoReply, JobIdentity } from './worker-protocol.js';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<CryptoJob>) => void;
  postMessage(reply: CryptoReply): void;
};
worker.onmessage = async ({ data: job }) => {
  // Explicit allowlist: never spread the request (which can carry a private key).
  const identity: JobIdentity = { jobId: job.jobId, epoch: job.epoch, scope: job.scope };
  try {
    if (job.kind === 'prove') {
      const range = generateRangeProof(...job.payload.range);
      const balance = generateBalanceProof(job.payload.balance);
      worker.postMessage({ ...identity, kind: 'result', jobKind: 'prove', value: { range, balance } });
    } else {
      const value = await decryptReceipt(job.payload);
      worker.postMessage({ ...identity, kind: 'result', jobKind: 'receive', value });
    }
  } catch {
    worker.postMessage({ ...identity, kind: 'error', jobKind: job.kind, code: 'CRYPTO_FAILED' });
  } finally {
    if (job.kind === 'receive') job.payload.recipientPrivateKey.fill(0);
  }
};
