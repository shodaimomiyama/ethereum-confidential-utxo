import type { Scope } from '@confidential-utxo/uniswap';
import type { CryptoJob, CryptoReply, CryptoResult, JobIdentity } from './worker-protocol.js';

export interface WorkerPort {
  onmessage: ((event: MessageEvent<CryptoReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(job: CryptoJob): void;
  terminate(): void;
}
export class CryptoWorkerError extends Error {
  constructor(readonly code: 'WORKER_UNAVAILABLE' | 'CANCELLED' | 'DISPOSED' | 'STALE_CONTEXT' | 'DUPLICATE_JOB' | 'CRYPTO_FAILED') {
    super(code); this.name = 'CryptoWorkerError';
  }
}
const sameScope = (a: Scope, b: Scope): boolean => a.deploymentId === b.deploymentId && a.owner.toLowerCase() === b.owner.toLowerCase();
interface Pending extends JobIdentity {
  readonly jobKind: CryptoJob['kind'];
  resolve(result: CryptoResult): void;
  reject(error: CryptoWorkerError): void;
}
export class CryptoWorkerClient {
  private worker?: WorkerPort;
  private context?: { scope: Scope; epoch: number };
  private generation = 0;
  private unavailable = false;
  private disposed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly used = new Set<string>();
  constructor(private readonly createWorker: () => WorkerPort = () => new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })) {}

  setContext(scope: Scope, epoch: number): void {
    if (this.disposed) throw new CryptoWorkerError('DISPOSED');
    if (this.context && epoch === this.context.epoch && sameScope(scope, this.context.scope)) return;
    if (this.context && epoch <= this.context.epoch) throw new CryptoWorkerError('STALE_CONTEXT');
    this.stop('CANCELLED');
    this.context = { scope: { ...scope }, epoch };
    this.used.clear();
  }
  run<J extends CryptoJob>(job: J): Promise<Extract<CryptoResult, { jobKind: J['kind'] }>>;
  run(job: CryptoJob): Promise<CryptoResult> {
    if (this.disposed) return Promise.reject(new CryptoWorkerError('DISPOSED'));
    if (this.unavailable) return Promise.reject(new CryptoWorkerError('WORKER_UNAVAILABLE'));
    if (!this.context) this.setContext(job.scope, job.epoch);
    if (job.epoch !== this.context!.epoch || !sameScope(job.scope, this.context!.scope)) return Promise.reject(new CryptoWorkerError('STALE_CONTEXT'));
    if (this.used.has(job.jobId)) return Promise.reject(new CryptoWorkerError('DUPLICATE_JOB'));
    return new Promise((resolve, reject) => {
      try {
        if (!this.worker) {
          this.worker = this.createWorker();
          const generation = this.generation;
          this.worker.onmessage = ({ data }) => {
            if (generation !== this.generation) return;
            const pending = this.pending.get(data.jobId);
            if (!pending || data.epoch !== pending.epoch || data.jobKind !== pending.jobKind || !sameScope(data.scope, pending.scope)) return;
            this.pending.delete(data.jobId);
            if (data.kind === 'result') pending.resolve(data);
            else pending.reject(new CryptoWorkerError('CRYPTO_FAILED'));
          };
          const fail = (): void => {
            if (generation !== this.generation) return;
            this.unavailable = true; this.stop('WORKER_UNAVAILABLE');
          };
          this.worker.onerror = fail; this.worker.onmessageerror = fail;
        }
        this.used.add(job.jobId);
        this.pending.set(job.jobId, { jobId: job.jobId, epoch: job.epoch, scope: { ...job.scope }, jobKind: job.kind, resolve, reject });
        this.worker.postMessage(job);
      } catch {
        this.unavailable = true; this.stop('WORKER_UNAVAILABLE');
        reject(new CryptoWorkerError('WORKER_UNAVAILABLE'));
      }
    });
  }
  /** Call only after the caller has reconciled reserved operations or chosen retry. */
  retry(): void {
    if (this.disposed) throw new CryptoWorkerError('DISPOSED');
    this.unavailable = false;
  }
  cancel(): void { this.stop('CANCELLED'); }
  dispose(): void { this.disposed = true; this.stop('CANCELLED'); this.context = undefined; this.used.clear(); }
  private stop(code: 'CANCELLED' | 'WORKER_UNAVAILABLE'): void {
    this.generation++;
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = undefined;
    }
    for (const pending of this.pending.values()) pending.reject(new CryptoWorkerError(code));
    this.pending.clear();
  }
}
