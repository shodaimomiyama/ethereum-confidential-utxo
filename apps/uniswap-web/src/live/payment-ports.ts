import { authorizationTypedData, verifyOperationAuthorization } from '@confidential-utxo/core';
import { createPaymentClient, paymentAuthorizationTypedData, paymentDigest,
  type Address, type PaymentClient, type PaymentPorts, type PaymentTerms, type PreparedPay,
  type ReservationPort, type SavedReservation } from '@confidential-utxo/uniswap';
import { hashTypedData, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { appendPaymentAuthorization, createPaymentRecordEncryptor, decodePaymentPrivateRecord,
  encodePaymentPrivateRecord, openPaymentPrivateRecord } from './payment-record.js';
import { paymentContentHash } from './payment-preparation.js';

type Prepared = Parameters<PaymentPorts['validatePrepared']>[0];
export interface PaymentManifestLocation {
  readonly chainId: bigint;
  readonly pool: Address | `0x${string}`;
  readonly adapter: Address | `0x${string}`;
}
/**
 * #30 preparation, history, quote and submission remain explicit dependencies.
 * Preparers encode PaymentPrivateRecord with the published typed-data payloads.
 * Recovery returns the supplied saved record and its decoded private bytes;
 * this binding independently authenticates that revision before reseeding.
 * Injected submitters use this action's context for any wallet transaction.
 */
export interface ScopedPaymentDependencies extends Pick<PaymentPorts,
  'reservations' | 'preparePay' | 'prepareFullWithdraw' | 'refreshPay' | 'validatePrepared' |
  'clock' | 'latestBlockTime' | 'createAttempt' | 'submit' | 'recovery' | 'reconciliation'> {
  readonly context: OperationContext;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) => PaymentManifestLocation | undefined;
  /** Extract the already validated, fixed terms; the published preparer owns decisions. */
  readonly paymentTerms: (prepared: Prepared) => PaymentTerms;
}
function canonical(value: unknown): string {
  if (value === null) return '["null"]';
  if (typeof value === 'bigint') return JSON.stringify(['bigint', value.toString()]);
  if (value instanceof Uint8Array) return JSON.stringify(['bytes', Array.from(value)]);
  if (Array.isArray(value)) return JSON.stringify(['array', value.map(canonical)]);
  if (typeof value === 'object') return JSON.stringify(['object', Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])]);
  return JSON.stringify([typeof value, value]);
}
function requireBinding(condition: boolean): asserts condition {
  if (!condition) throw new Error('INVALID_PAYMENT_BINDING');
}

/** One captured controller action. #55 alone owns reservation/sign/submit ordering. */
export function createScopedPaymentClient(deps: ScopedPaymentDependencies): PaymentClient {
  const context = deps.context;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const found = deps.resolveDeployment(scope.deploymentId);
  if (!found) throw new Error('SCOPE_CHANGED');
  const deployment = { ...found, pool: found.pool as Address, adapter: found.adapter as Address };
  function check(): void {
    context.check();
    const current = deps.resolveDeployment(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current
      || current.chainId !== deployment.chainId || current.pool.toLowerCase() !== deployment.pool.toLowerCase()
      || current.adapter.toLowerCase() !== deployment.adapter.toLowerCase()) throw new Error('SCOPE_CHANGED');
  }
  function guarded<A extends unknown[], R>(callback: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => { check(); try { return await callback(...args); } finally { check(); } };
  }
  check();
  const key = context.recordKey();
  const encrypt = createPaymentRecordEncryptor(key, { ...deployment, ...scope });
  const latest = new Map<string, { bytes: Uint8Array; revision: number }>();
  const pools = new Map<string, ReturnType<typeof authorizationTypedData>>();
  function validate(prepared: Prepared): ReturnType<typeof paymentAuthorizationTypedData> | undefined {
    check();
    const plain = decodePaymentPrivateRecord(prepared.privateBytes);
    const { encryptedBundle: _, signatureStarted, attemptIds, ...binding } = prepared.record;
    const normalize = (value: typeof binding) => ({ ...value, scope: { ...value.scope, owner: value.scope.owner.toLowerCase() } });
    requireBinding(sameScope(binding.scope, scope) && canonical(normalize(binding)) === canonical(normalize(plain.binding))
      && canonical(attemptIds) === canonical(plain.attempts.map(attempt => attempt.attemptId))
      && (plain.signatures === undefined || signatureStarted));
    const draft = plain.creationInputs;
    requireBinding(draft.context.chainId === deployment.chainId && draft.context.pool.toLowerCase() === deployment.pool.toLowerCase());
    const pool = authorizationTypedData(draft.context, draft.request);
    requireBinding(canonical(pool) === canonical(prepared.poolAuthorization) && canonical(pool) === canonical(plain.intendedAuthorization.pool));
    let payment: ReturnType<typeof paymentAuthorizationTypedData> | undefined;
    if (prepared.record.kind === 'pay') {
      const terms = deps.paymentTerms(prepared);
      check();
      const pay = prepared as PreparedPay;
      requireBinding(pay.quote !== undefined
        && paymentContentHash(draft, terms, pay.quote, deployment) === prepared.record.contentHash);
      payment = paymentAuthorizationTypedData(terms, deployment.chainId, deployment.adapter);
      requireBinding(terms.operationId === prepared.record.operationId && terms.owner.toLowerCase() === scope.owner.toLowerCase()
        && terms.deadline === prepared.record.deadline && terms.ethAmount === draft.request.w
        && draft.request.destination.toLowerCase() === deployment.adapter.toLowerCase()
        && paymentDigest(terms, deployment.chainId, deployment.adapter) === prepared.record.paymentId
        && canonical(payment) === canonical(plain.intendedAuthorization.payment));
    }
    pools.set(canonical(pool), structuredClone(pool));
    return payment;
  }
  function accept<T extends Prepared>(prepared: T, changedTerms = false): T {
    const snapshot = structuredClone(prepared);
    validate(snapshot);
    const existing = latest.get(snapshot.record.operationId);
    if (existing) {
      const old = decodePaymentPrivateRecord(existing.bytes);
      const next = decodePaymentPrivateRecord(snapshot.privateBytes);
      if (canonical(old.binding) !== canonical(next.binding) || canonical(old.intendedAuthorization) !== canonical(next.intendedAuthorization)) {
        requireBinding(changedTerms && snapshot.record.kind === 'pay' && old.binding.kind === 'pay'
          && existing.revision === 0 && old.signatures === undefined && old.attempts.length === 0
          && next.signatures === undefined && next.attempts.length === 0
          && canonical(old.creationInputs) === canonical(next.creationInputs)
          && old.binding.scope.deploymentId === next.binding.scope.deploymentId
          && old.binding.scope.owner.toLowerCase() === next.binding.scope.owner.toLowerCase()
          && old.binding.recordId === next.binding.recordId && old.binding.inputId === next.binding.inputId
          && old.binding.operationId === next.binding.operationId);
        latest.set(snapshot.record.operationId, { bytes: snapshot.privateBytes.slice(), revision: 0 });
      }
    } else latest.set(snapshot.record.operationId, { bytes: snapshot.privateBytes.slice(), revision: 0 });
    return snapshot;
  }
  async function restore<T extends { prepared: Prepared; signatures?: { pool: `0x${string}`; payment?: `0x${string}` } }>(saved: SavedReservation, restored: T): Promise<T> {
    check();
    const current = await reservations.get(scope, saved.record.recordId);
    requireBinding(current !== undefined && current.revision === saved.revision && current.reservationState === saved.reservationState
      && canonical(current.record) === canonical(saved.record) && canonical(restored.prepared.record) === canonical(saved.record));
    const plain = await openPaymentPrivateRecord(key, { ...deployment, ...scope, recordId: saved.record.recordId, revision: saved.revision }, saved.record);
    check();
    requireBinding(canonical(decodePaymentPrivateRecord(restored.prepared.privateBytes)) === canonical(plain)
      && canonical(restored.signatures) === canonical(plain.signatures));
    const prepared = accept(restored.prepared);
    if (plain.signatures) {
      await verifyOperationAuthorization(deployment, prepared.record.operationId, scope.owner, plain.signatures.pool);
      check();
      const payment = validate(prepared);
      if (payment) { requireBinding(plain.signatures.payment !== undefined); await verifySignature(payment, plain.signatures.payment); }
    }
    const previous = latest.get(prepared.record.operationId)!;
    requireBinding(previous.revision <= saved.revision);
    // Even an unacknowledged local update may contain signatures or attempts that
    // a stale server response must never erase.
    const previousPlain = decodePaymentPrivateRecord(previous.bytes);
    if (previousPlain.signatures) requireBinding(canonical(previousPlain.signatures) === canonical(plain.signatures));
    for (const attempt of previousPlain.attempts) requireBinding(plain.attempts.some(item => item.attemptId === attempt.attemptId
      && (attempt.txHash === undefined || item.txHash === attempt.txHash)));
    latest.set(prepared.record.operationId, { bytes: encodePaymentPrivateRecord(plain), revision: saved.revision });
    return { ...restored, prepared };
  }
  const reservations: ReservationPort = {
    reserve: guarded((...args) => deps.reservations.reserve(...args)), update: guarded((...args) => deps.reservations.update(...args)),
    get: guarded((...args) => deps.reservations.get(...args)), list: guarded((...args) => deps.reservations.list(...args)),
    release: guarded((...args) => deps.reservations.release(...args)),
  };
  async function verifySignature(data: TypedDataDefinition, signature: `0x${string}`): Promise<void> {
    check();
    requireBinding(/^0x[0-9a-fA-F]{130}$/.test(signature));
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    requireBinding(s > 0n && s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
      && ['1b', '1c'].includes(signature.slice(130).toLowerCase()));
    const owner = await recoverTypedDataAddress({ ...data, signature });
    check();
    requireBinding(owner.toLowerCase() === scope.owner.toLowerCase());
  }
  async function sign(data: TypedDataDefinition, purpose: 'pool-authorization' | 'payment-authorization'): Promise<`0x${string}`> {
    check();
    const expected = hashTypedData(data);
    const returned = await context.typedSign(structuredClone(data), purpose);
    check();
    requireBinding(returned.epoch === epoch && sameScope(returned.scope, scope) && /^0x[0-9a-fA-F]{130}$/.test(returned.value));
    const signature = returned.value as `0x${string}`;
    await verifySignature(data, signature);
    requireBinding(hashTypedData(data) === expected);
    return signature;
  }
  const ports: PaymentPorts = {
    reservations, currentScope: () => { check(); return scope; }, clock: { now: () => { check(); const value = deps.clock.now(); check(); return value; } },
    latestBlockTime: guarded(() => deps.latestBlockTime()),
    preparePay: guarded(async input => accept(await deps.preparePay(input))),
    prepareFullWithdraw: guarded(async input => accept(await deps.prepareFullWithdraw(input))),
    refreshPay: guarded(async prepared => accept(await deps.refreshPay(prepared), true)),
    validatePrepared: guarded(async prepared => { validate(prepared); await deps.validatePrepared(prepared); validate(prepared); }),
    encrypt: guarded(async (bytes, aad) => {
      const result = await encrypt(bytes, aad); check();
      const id = decodePaymentPrivateRecord(bytes).operationId;
      const previous = latest.get(id);
      if (previous) previous.revision = Math.max(previous.revision, aad.revision);
      return result;
    }),
    sealContent: (prepared, signatures, attemptId, txHash) => {
      check(); validate(prepared);
      const previous = latest.get(prepared.record.operationId);
      requireBinding(previous !== undefined);
      const bytes = appendPaymentAuthorization(previous.bytes, signatures, attemptId, txHash);
      latest.set(prepared.record.operationId, { ...previous, bytes });
      return bytes.slice();
    },
    signPool: guarded(async payload => {
      const data = pools.get(canonical(payload)); requireBinding(data !== undefined);
      const signature = await sign(data, 'pool-authorization');
      await verifyOperationAuthorization({ chainId: deployment.chainId, pool: deployment.pool }, data.message.operationId, scope.owner, signature);
      return signature;
    }),
    signPayment: guarded(async prepared => {
      const payment = validate(prepared); requireBinding(payment !== undefined);
      return sign(payment, 'payment-authorization');
    }),
    createAttempt: (prepared, signatures) => { check(); const id = deps.createAttempt(prepared, signatures); check(); return id; },
    submit: guarded((...args) => deps.submit(...args)),
    ...(deps.recovery ? { recovery: {
      readEvidence: guarded((...args) => deps.recovery!.readEvidence(...args)),
      restoreOriginal: guarded(async (saved, evidence) => restore(saved, await deps.recovery!.restoreOriginal(saved, evidence))),
      restoreForRetry: guarded(async (saved, evidence) => restore(saved, await deps.recovery!.restoreForRetry(saved, evidence))),
      releaseAndPrepareChangedTerms: guarded(async (...args) => accept(await deps.recovery!.releaseAndPrepareChangedTerms(...args))),
    } } : {}),
    ...(deps.reconciliation ? { reconciliation: { expectedChainId: deployment.chainId,
      readFinalized: guarded((...args) => deps.reconciliation!.readFinalized(...args)) } } : {}),
  };
  if (deps.reconciliation) requireBinding(deps.reconciliation.expectedChainId === deployment.chainId);
  const client = createPaymentClient(ports);
  // #55 treats submission exceptions as unknown. This final guard also prevents
  // a recovered submission exception from returning across an invalidated epoch.
  return { preparePay: guarded(client.preparePay), prepareFullWithdraw: guarded(client.prepareFullWithdraw),
    authorizePay: guarded((prepared, confirmation) => client.authorizePay(accept(prepared), confirmation)),
    authorizeFullWithdraw: guarded((prepared, confirmation) => client.authorizeFullWithdraw(accept(prepared), confirmation)),
    resumeOriginal: guarded(client.resumeOriginal), retryAttempt: guarded(client.retryAttempt),
    prepareChangedTerms: guarded(client.prepareChangedTerms), reconcile: guarded(client.reconcile) };
}
