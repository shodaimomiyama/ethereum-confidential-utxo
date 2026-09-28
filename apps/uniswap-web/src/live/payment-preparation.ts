import { authorizationTypedData, operationId, type LocalDraft } from '@confidential-utxo/core';
import { assertWithdrawalBinding, paymentAuthorizationTypedData, paymentDigest,
  type Address, type Bytes32, type OperationRecord, type PaymentDeployment, type PaymentTerms,
  type PreparedFullWithdraw, type PreparedPay, type Scope } from '@confidential-utxo/uniswap';
import { keccak256, stringToHex } from 'viem';
import { decodePaymentPrivateRecord, encodePaymentPrivateRecord, type PaymentPrivateRecord } from './payment-record.js';
import type { OperationContext } from './operations.js';
import type { CryptoPayloads } from './worker-protocol.js';

export interface PreparationIdentity {
  readonly scope: Scope;
  readonly recordId: Bytes32;
  readonly contentHash: Bytes32;
}
export interface PreparationDeployment extends PaymentDeployment {
  readonly chainId: bigint;
}
export type PreparationDecision =
  | { readonly kind: 'pay'; readonly identity: PreparationIdentity; readonly deployment: PreparationDeployment;
      readonly terms: PaymentTerms; readonly quote: PreparedPay['quote'] }
  | { readonly kind: 'withdraw'; readonly identity: PreparationIdentity; readonly deployment: PreparationDeployment };

function requireValid(condition: boolean): asserts condition {
  if (!condition) throw new Error('INVALID_PAYMENT_PREPARATION');
}
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const equal = (a: unknown, b: unknown): boolean => {
  // Typed-data objects contain bigints, so JSON.stringify alone cannot compare them.
  const normalize = (value: unknown): unknown => typeof value === 'bigint' ? ['bigint', value.toString()]
    : Array.isArray(value) ? value.map(normalize)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};

/** Hash the fixed payment decision shown to the user, independent of quote transport metadata. */
export function paymentContentHash(draft: LocalDraft, terms: PaymentTerms, quote: PreparedPay['quote'],
  deployment: { readonly chainId: bigint; readonly adapter: Address | `0x${string}` }): Bytes32 {
  const content = ['confidential-utxo-payment-content', 1, deployment.chainId.toString(), deployment.adapter.toLowerCase(),
    draft.operationId.toLowerCase(), draft.request.inputIds[0]?.toLowerCase(),
    terms.owner.toLowerCase(), terms.ethAmount.toString(), terms.token.toLowerCase(),
    terms.minAmountOut.toString(), terms.recipient.toLowerCase(), terms.deadline.toString(),
    quote.quoteOut.toString()];
  return keccak256(stringToHex(JSON.stringify(content))) as Bytes32;
}

/** The caller supplies the selected input, terms, and display hash; this binds their decision to a Worker draft. */
export function buildPreparedPayment(draft: LocalDraft, decision: PreparationDecision): PreparedPay | PreparedFullWithdraw {
  const { identity, deployment } = decision;
  requireValid(identity.scope.deploymentId.length > 0 && same(identity.scope.owner, draft.request.owner)
    && draft.context.chainId === deployment.chainId && same(draft.context.pool, deployment.pool)
    && draft.request.kind === 2 && draft.request.d === 0n && draft.request.inputIds.length === 1
    && draft.request.inputIds[0] !== undefined && draft.operationId === operationId(draft.context, draft.request)
    && draft.signature === undefined && /^0x[0-9a-fA-F]{64}$/.test(identity.recordId)
    && /^0x[0-9a-fA-F]{64}$/.test(identity.contentHash));
  const common = { scope: structuredClone(identity.scope), recordId: identity.recordId,
    inputId: draft.request.inputIds[0] as OperationRecord['inputId'], operationId: draft.operationId as OperationRecord['operationId'],
    contentHash: identity.contentHash };
  const pool = authorizationTypedData(draft.context, draft.request);
  let record: OperationRecord;
  let intendedAuthorization: PaymentPrivateRecord['intendedAuthorization'];
  if (decision.kind === 'pay') {
    assertWithdrawalBinding(draft, decision.terms, deployment);
    requireValid(decision.quote.inputWei === decision.terms.ethAmount && decision.quote.quoteOut > 0n
      && Number.isFinite(decision.quote.startedAtMs) && decision.quote.blockNumber >= 0n
      && /^0x[0-9a-fA-F]{64}$/.test(decision.quote.blockHash));
    requireValid(same(identity.contentHash, paymentContentHash(draft, decision.terms, decision.quote, deployment)));
    const payment = paymentAuthorizationTypedData(decision.terms, deployment.chainId, deployment.adapter);
    record = { ...common, kind: 'pay', paymentId: paymentDigest(decision.terms, deployment.chainId, deployment.adapter),
      deadline: decision.terms.deadline, encryptedBundle: { ciphertext: '', nonce: '', tag: '' },
      signatureStarted: false, attemptIds: [] };
    intendedAuthorization = { pool, payment };
  } else {
    requireValid(draft.request.outputs.length === 0 && draft.rangeProofs.length === 0
      && draft.request.w === draft.inputOpenings[0]?.amount && draft.request.w > 0n
      && same(draft.request.destination, identity.scope.owner));
    record = { ...common, kind: 'withdraw', encryptedBundle: { ciphertext: '', nonce: '', tag: '' },
      signatureStarted: false, attemptIds: [] };
    intendedAuthorization = { pool };
  }
  const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = record;
  const privateBytes = encodePaymentPrivateRecord({ version: 1, creationInputs: structuredClone(draft), binding,
    operationId: record.operationId, ...(record.kind === 'pay' ? { paymentId: record.paymentId } : {}),
    ...(decision.kind === 'pay' ? { quote: structuredClone(decision.quote) } : {}),
    intendedAuthorization, attempts: [], recoveryMarkers: {} });
  const base = { record, poolAuthorization: pool, privateBytes };
  return decision.kind === 'pay' ? { ...base, quote: structuredClone(decision.quote) } as PreparedPay
    : base as PreparedFullWithdraw;
}

/** Runs the published #29 Worker operation and checks its reply before building the private record. */
export async function preparePaymentWithWorker(context: OperationContext,
  payload: CryptoPayloads['build-operation'], decision: (draft: LocalDraft) => PreparationDecision,
  jobId: string): Promise<PreparedPay | PreparedFullWithdraw> {
  context.check();
  const reply = await context.runCrypto({ kind: 'build-operation', jobId, payload });
  context.check();
  requireValid(reply.kind === 'result' && reply.jobKind === 'build-operation'
    && reply.jobId === jobId && reply.epoch === context.epoch && reply.scope.deploymentId === context.scope.deploymentId
    && same(reply.scope.owner, context.scope.owner));
  const selected = decision(reply.value);
  context.check();
  requireValid(selected.identity.scope.deploymentId === context.scope.deploymentId
    && same(selected.identity.scope.owner, context.scope.owner));
  const result = buildPreparedPayment(reply.value, selected);
  context.check();
  return result;
}

/** Validate a prepared value against the same published decision after a quote or context refresh. */
export function validatePreparedPayment(prepared: PreparedPay | PreparedFullWithdraw,
  decision: PreparationDecision): void {
  const record = decodePaymentPrivateRecord(prepared.privateBytes);
  const expected = buildPreparedPayment(record.creationInputs, decision);
  const { encryptedBundle: _a, signatureStarted, attemptIds, ...actualBinding } = prepared.record;
  const { encryptedBundle: _b, signatureStarted: _c, attemptIds: _d, ...expectedBinding } = expected.record;
  const baseline = decodePaymentPrivateRecord(expected.privateBytes);
  requireValid(equal(actualBinding, expectedBinding)
    && equal(prepared.poolAuthorization, expected.poolAuthorization)
    && equal(record.creationInputs, baseline.creationInputs)
    && equal(record.binding, baseline.binding)
    && equal(record.intendedAuthorization, baseline.intendedAuthorization)
    && record.operationId === baseline.operationId && record.paymentId === baseline.paymentId
    && equal(attemptIds, record.attempts.map(attempt => attempt.attemptId))
    && (record.signatures === undefined || signatureStarted)
    && (record.attempts.length === 0 || record.signatures !== undefined)
    && (decision.kind !== 'pay' || ('quote' in prepared && 'quote' in expected && equal(prepared.quote, expected.quote))));
}

export interface PaymentPreparationPlan {
  readonly payload: CryptoPayloads['build-operation'];
  readonly decide: (draft: LocalDraft) => PreparationDecision;
}
export interface PaymentPreparationDependencies {
  readonly context: OperationContext;
  readonly jobId: () => string;
  readonly payPlan: (input: unknown) => Promise<PaymentPreparationPlan>;
  readonly withdrawPlan: (input: unknown) => Promise<PaymentPreparationPlan>;
  /** A refreshed quote keeps the original Worker draft and must supply a new exact decision. */
  readonly refreshDecision: (prepared: PreparedPay, draft: LocalDraft) => Promise<PreparationDecision>;
  /** The application supplies its current manifest, input, quote and terms decision. */
  readonly currentDecision: (prepared: PreparedPay | PreparedFullWithdraw, draft: LocalDraft) => PreparationDecision;
}

/** Scoped #55 preparation methods. Selection, quote and terms remain injected decisions. */
export function createPaymentPreparationPorts(deps: PaymentPreparationDependencies): {
  readonly preparePay: (input: unknown) => Promise<PreparedPay>;
  readonly prepareFullWithdraw: (input: unknown) => Promise<PreparedFullWithdraw>;
  readonly refreshPay: (prepared: PreparedPay) => Promise<PreparedPay>;
  readonly validatePrepared: (prepared: PreparedPay | PreparedFullWithdraw) => Promise<void>;
  readonly paymentTerms: (prepared: PreparedPay | PreparedFullWithdraw) => PaymentTerms;
} {
  const context = deps.context;
  function check(): void { context.check(); }
  async function prepare(input: unknown, planProvider: (input: unknown) => Promise<PaymentPreparationPlan>, kind: PreparationDecision['kind']) {
    check();
    const plan = await planProvider(input);
    check();
    const prepared = await preparePaymentWithWorker(context, plan.payload, plan.decide, deps.jobId());
    check();
    requireValid(prepared.record.kind === kind);
    return prepared;
  }
  function current(prepared: PreparedPay | PreparedFullWithdraw): PreparationDecision {
    check();
    const draft = decodePaymentPrivateRecord(prepared.privateBytes).creationInputs;
    const decision = deps.currentDecision(prepared, draft);
    check();
    validatePreparedPayment(prepared, decision);
    return decision;
  }
  return {
    preparePay: async input => await prepare(input, deps.payPlan, 'pay') as PreparedPay,
    prepareFullWithdraw: async input => await prepare(input, deps.withdrawPlan, 'withdraw') as PreparedFullWithdraw,
    refreshPay: async prepared => {
      check();
      const previous = decodePaymentPrivateRecord(prepared.privateBytes);
      requireValid(!prepared.record.signatureStarted && prepared.record.attemptIds.length === 0
        && previous.signatures === undefined && previous.attempts.length === 0);
      const draft = decodePaymentPrivateRecord(prepared.privateBytes).creationInputs;
      const decision = await deps.refreshDecision(prepared, draft);
      check();
      requireValid(decision.kind === 'pay');
      const next = buildPreparedPayment(draft, decision) as PreparedPay;
      requireValid(next.record.operationId === prepared.record.operationId && next.record.inputId === prepared.record.inputId);
      return next;
    },
    validatePrepared: async prepared => { current(prepared); },
    paymentTerms: prepared => {
      const decision = current(prepared);
      requireValid(decision.kind === 'pay');
      return decision.terms;
    },
  };
}
