import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { CryptoWorkerClient, type WorkerPort } from '../../src/live/worker-client.js';
import type { CryptoJob, CryptoReply } from '../../src/live/worker-protocol.js';
const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
class FakeWorker implements WorkerPort {
  onmessage: ((event: MessageEvent<CryptoReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  postMessage(_job: CryptoJob) {}
  terminate() { this.terminated = true; }
  emit(reply: CryptoReply) { this.onmessage?.({ data: reply } as MessageEvent<CryptoReply>); }
}
const job = (jobId: string, epoch = 0): CryptoJob => ({ kind: 'prove', jobId, epoch, scope,
  payload: { range: [{ amount: 1n, blinding: 0n }, new Uint8Array(32), 0n],
    balance: { X: { x: 0n, y: 0n }, x: 0n, chainId: 1n, pool: new Uint8Array(20), operationId: new Uint8Array(32) } } });
const reply = (jobId: string, epoch = 0): CryptoReply => ({ kind: 'result', jobKind: 'prove', jobId, epoch, scope,
  value: { range: { coords: [], scalars: [], ls: [], rs: [] }, balance: { Rx: 1n, Ry: 2n, s: 3n } } });
it('matches concurrent results by ID and rejects duplicate IDs', async () => {
  const worker = new FakeWorker(); const client = new CryptoWorkerClient(() => worker);
  const first = client.run(job('one')); const second = client.run(job('two'));
  let settled = false; void first.then(() => { settled = true; });
  await expect(client.run(job('one'))).rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
  worker.emit(reply('two')); await expect(second).resolves.toMatchObject({ jobId: 'two' });
  expect(settled).toBe(false); worker.emit(reply('one')); await expect(first).resolves.toMatchObject({ jobId: 'one' });
  client.dispose();
});
it('terminates scope generations and ignores an A to B to A late result', async () => {
  const workers: FakeWorker[] = []; const client = new CryptoWorkerClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const first = client.run(job('same')); const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
  const late = workers[0]!.onmessage!;
  client.setContext({ ...scope, owner: `0x${'22'.repeat(20)}` as Scope['owner'] }, 1); client.setContext(scope, 2);
  await rejected; expect(workers[0]!.terminated).toBe(true); expect(workers).toHaveLength(1);
  const current = client.run(job('same', 2)); let settled = false; void current.then(() => { settled = true; });
  late({ data: reply('same') } as MessageEvent<CryptoReply>); await Promise.resolve(); expect(settled).toBe(false);
  workers[1]!.emit(reply('same', 2)); await current; client.dispose();
});
it('settles all pending jobs on crash and requires explicit retry', async () => {
  const worker = new FakeWorker(); let created = 0; const client = new CryptoWorkerClient(() => { created++; return worker; });
  const promises = [client.run(job('a')), client.run(job('b'))];
  worker.onerror?.();
  for (const promise of promises) await expect(promise).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  await expect(client.run(job('c'))).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' }); expect(created).toBe(1);
  client.retry(); const retried = client.run(job('c')); worker.emit(reply('c')); await retried; expect(created).toBe(2); client.dispose();
});
it('cancellation does not mutate a reserved operation ID and dispose settles pending jobs', async () => {
  const worker = new FakeWorker(); const client = new CryptoWorkerClient(() => worker); const reserved = job('reserved');
  const before = structuredClone(reserved); const pending = client.run(reserved); client.cancel();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); expect(reserved).toEqual(before);
  const next = client.run(job('next')); client.dispose(); await expect(next).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(client.run(job('last'))).rejects.toMatchObject({ code: 'DISPOSED' });
});
it('ignores wrong scope, epoch and job kind and handles message decoding failure', async () => {
  const worker = new FakeWorker(); const client = new CryptoWorkerClient(() => worker);
  const pending = client.run(job('one')); let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  worker.emit(reply('one', 1));
  worker.emit({ ...reply('one'), scope: { ...scope, deploymentId: 'elsewhere' as Scope['deploymentId'] } });
  worker.emit({ kind: 'result', jobKind: 'receive', jobId: 'one', epoch: 0, scope, value: { amount: 1n, blinding: 0n } });
  await Promise.resolve(); expect(settled).toBe(false);
  worker.onmessageerror?.(); await expect(pending).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  expect(worker.terminated).toBe(true);
});
it('settles constructor and postMessage failures without exposing exception contents', async () => {
  const unavailable = new CryptoWorkerClient(() => { throw new Error('secret'); });
  await expect(unavailable.run(job('one'))).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE', message: 'WORKER_UNAVAILABLE' });
  const worker = new FakeWorker(); worker.postMessage = () => { throw new Error('secret'); };
  const client = new CryptoWorkerClient(() => worker);
  await expect(client.run(job('two'))).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE', message: 'WORKER_UNAVAILABLE' });
  expect(worker.terminated).toBe(true);
});
