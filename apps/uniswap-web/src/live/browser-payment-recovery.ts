import { readWithPolicy, type RpcConnection, type VerifiedDeployment } from '@confidential-utxo/ethereum';
import { inspectOperation, type Bytes32, type PaymentPorts, type RecoveryPorts, type SavedReservation,
  type OperationRef, type PreparedPay, type PreparedFullWithdraw } from '@confidential-utxo/uniswap';
import type { BrowserDeployment } from './deployment.js';
import { createScopedEthereumBridge } from './ethereum.js';
import { createHttpClient, sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { createPaymentRecordEncryptor, encodePaymentPrivateRecord,
  openPaymentPrivateRecord } from './payment-record.js';
import type { PreparationDeployment } from './payment-preparation.js';
import { createReservationPort } from './reservations.js';

export interface BrowserPaymentRecoveryDependencies {
  readonly context: OperationContext;
  readonly verified: VerifiedDeployment;
  readonly rpc: RpcConnection;
  readonly browser: BrowserDeployment;
  readonly deployment: PreparationDeployment;
  readonly resolveVerified: (id: OperationContext['scope']['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) => PreparationDeployment | undefined;
  readonly reconciliation: NonNullable<PaymentPorts['reconciliation']>;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? ['bigint', item.toString()] : item);
function blocked(): never { throw new Error('PAYMENT_RECOVERY_BLOCKED'); }

/** Uses only saved encrypted state and finalized chain evidence; missing attempt hashes stay unknown. */
export function createBrowserPaymentRecovery(deps: BrowserPaymentRecoveryDependencies): RecoveryPorts {
  const { context, rpc, reconciliation } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const verified = structuredClone(deps.verified);
  const deployment = structuredClone(deps.deployment);
  const browser = structuredClone(deps.browser);
  const verifiedId = fingerprint(verified);
  const deploymentId = fingerprint(deployment);
  const browserId = fingerprint(browser);
  function check(): void {
    context.check();
    if (!sameScope(scope, context.scope) || epoch !== context.epoch
      || fingerprint(deps.verified) !== verifiedId || fingerprint(deps.deployment) !== deploymentId
      || fingerprint(deps.browser) !== browserId
      || fingerprint(deps.resolveVerified(scope.deploymentId)) !== verifiedId
      || fingerprint(deps.resolveDeployment(scope.deploymentId)) !== deploymentId
      || scope.deploymentId !== browser.deploymentId || browser.chainId !== deployment.chainId
      || verified.context.chainId !== deployment.chainId || BigInt(verified.manifest.chainId) !== deployment.chainId
      || rpc.mode !== verified.context.finalityMode || reconciliation.expectedChainId !== deployment.chainId
      || !same(browser.pool, deployment.pool) || !same(browser.adapter, deployment.adapter)
      || !same(verified.context.pool, deployment.pool) || !same(verified.manifest.pool.address, deployment.pool)) {
      throw new Error('SCOPE_CHANGED');
    }
  }
  check();
  const reservations = createReservationPort(createHttpClient({ origin: browser.origin }));
  const { history } = createScopedEthereumBridge({ context, rpc, resolveVerified: deps.resolveVerified });
  const encrypt = createPaymentRecordEncryptor(context.recordKey(), { deploymentId: scope.deploymentId,
    chainId: deployment.chainId, pool: deployment.pool, owner: scope.owner });
  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    check();
    try { return await read(); } finally { check(); }
  }
  const rpcRead = <T>(read: () => Promise<T>) => guarded(() => readWithPolicy(read, rpc.policy));
  function checkSaved(saved: SavedReservation): void {
    check();
    if (!sameScope(saved.record.scope, scope) || saved.record.scope.deploymentId !== browser.deploymentId
      || saved.revision < 1) blocked();
  }
  async function open(saved: SavedReservation) {
    checkSaved(saved);
    const current = await guarded(() => reservations.get(scope, saved.record.recordId));
    if (!current || current.revision !== saved.revision
      || current.reservationState !== saved.reservationState
      || fingerprint(current.record) !== fingerprint(saved.record)) blocked();
    return guarded(() => openPaymentPrivateRecord(context.recordKey(), { deploymentId: scope.deploymentId,
      chainId: deployment.chainId, pool: deployment.pool, owner: scope.owner,
      recordId: saved.record.recordId, revision: saved.revision }, saved.record));
  }
  async function evidence(saved: SavedReservation) {
    const plain = await open(saved);
    const point = await guarded(() => history.getFinalizedCheckpoint());
    if (!point || point.mode !== verified.context.finalityMode
      || point.number < verified.context.deploymentBlock) throw new Error('PAYMENT_CHECKPOINT_UNAVAILABLE');
    const block = await rpcRead(() => rpc.client.getBlock({ blockNumber: point.number }));
    if (!block.hash || !same(block.hash, point.hash)) throw new Error('PAYMENT_CHECKPOINT_REORG');
    if (BigInt(await rpcRead(() => rpc.client.getChainId())) !== deployment.chainId) blocked();
    const observed = await guarded(() => history.getUtxo(saved.record.inputId, point));
    if (!observed.complete || !same(observed.blockHash, point.hash)) throw new Error('PAYMENT_HISTORY_UNAVAILABLE');
    const input = observed.value;
    if (input.exists && !same(input.owner ?? '', scope.owner)) blocked();
    const reference: OperationRef = { scope, operationId: saved.record.operationId,
      ...(saved.record.kind === 'pay' ? { paymentId: saved.record.paymentId } : {}),
      attemptIds: saved.record.attemptIds, txHashes: [], chainOutcome: 'unknown', receiptState: 'none' };
    const result = saved.record.kind === 'pay'
      ? await guarded(() => reconciliation.readFinalized(reference, saved)) : undefined;
    if (result && (!result.history.finalized || !result.history.canonical
      || !same(result.history.checkpoint.hash, point.hash))) blocked();
    const attempts = await Promise.all(plain.attempts.map(async attempt => {
      if (!attempt.txHash) return { id: attempt.attemptId, outcome: 'unknown' as const };
      try {
        const receipt = await rpcRead(() => rpc.client.getTransactionReceipt({ hash: attempt.txHash! }));
        if (receipt.blockNumber > point.number) return { id: attempt.attemptId, outcome: 'pending' as const };
        const header = await rpcRead(() => rpc.client.getBlock({ blockNumber: receipt.blockNumber }));
        if (!header.hash || !same(header.hash, receipt.blockHash)
          || !same(receipt.transactionHash, attempt.txHash!)) return { id: attempt.attemptId, outcome: 'unknown' as const };
        return { id: attempt.attemptId, outcome: receipt.status === 'reverted'
          ? 'finalized-failure' as const : 'unknown' as const };
      } catch { check(); return { id: attempt.attemptId, outcome: 'unknown' as const }; }
    }));
    const after = await rpcRead(() => rpc.client.getBlock({ blockNumber: point.number }));
    if (!after.hash || !same(after.hash, point.hash)) throw new Error('PAYMENT_CHECKPOINT_REORG');
    return { evidence: { finalized: true, blockTime: block.timestamp,
      paymentSucceeded: result?.history.adapter !== undefined,
      submissionKnownAbsent: saved.record.attemptIds.length === 0,
      attempts, storageAvailability: 'healthy' as const },
    currentInput: { state: !input.exists ? 'unknown' as const : input.consumedBy ? 'spent' as const : 'unspent' as const },
    pointHash: point.hash as Bytes32 };
  }
  async function restore(saved: SavedReservation) {
    const plain = await open(saved);
    const bytes = encodePaymentPrivateRecord(plain);
    const base = { record: saved.record, privateBytes: bytes,
      poolAuthorization: plain.intendedAuthorization.pool };
    if (saved.record.kind === 'pay') {
      if (!plain.quote) blocked();
      return { prepared: { ...base, quote: plain.quote } as PreparedPay,
        ...(plain.signatures ? { signatures: plain.signatures } : {}) };
    }
    return { prepared: base as PreparedFullWithdraw,
      ...(plain.signatures ? { signatures: plain.signatures } : {}) };
  }
  return {
    async readEvidence(saved) {
      const { evidence: result, currentInput } = await evidence(saved);
      return { evidence: result, currentInput };
    },
    restoreOriginal: restore,
    async restoreForRetry(saved) {
      const result = await restore(saved);
      if (!result.signatures || (saved.record.kind === 'pay' && !result.signatures.payment)) blocked();
      return { prepared: result.prepared, signatures: result.signatures };
    },
    async releaseOriginal(saved) {
      const fresh = await evidence(saved);
      if (inspectOperation(saved, fresh.evidence, fresh.currentInput).action !== 'change-terms') blocked();
      const plain = await open(saved);
      const revision = saved.revision + 1;
      const encryptedBundle = await guarded(() => encrypt(encodePaymentPrivateRecord(plain), {
        scope, recordId: saved.record.recordId, revision }));
      const point = await guarded(() => history.getFinalizedCheckpoint());
      if (!point || point.mode !== verified.context.finalityMode || !same(point.hash, fresh.pointHash)) blocked();
      return guarded(() => reservations.release({ ...saved.record, encryptedBundle },
        { blockHash: point.hash as Bytes32 }, saved.revision, revision));
    },
  };
}
