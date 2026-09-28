import { recipientInfoTypedData, verifyRecipientInfo, type OwnedUtxo } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import { parseEthAmount, type Address, type AttemptId, type Bytes32, type MonotonicClock, type PaymentClient, type PaymentPorts,
  PreparedPay, Scope } from '@confidential-utxo/uniswap';
import { isAddress } from 'viem';
import type { BrowserDeployment } from './deployment.js';
import { createHttpClient } from './http.js';
import type { OperationContext } from './operations.js';
import { createPaymentDecisions } from './payment-decisions.js';
import { createBrowserPaymentDecisions } from './browser-payment-decisions.js';
import { createScopedPaymentClient } from './payment-ports.js';
import { createPaymentPreparationPorts, paymentContentHash, type PaymentPreparationDependencies,
  type PreparationDeployment } from './payment-preparation.js';
import { createPaymentSubmit } from './payment-submit.js';
import { createBrowserQuoteReader } from './quote-reader.js';
import { createReservationPort } from './reservations.js';

export interface BrowserPaymentDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly verified: VerifiedDeployment;
  readonly browser: BrowserDeployment;
  readonly deployment: PreparationDeployment;
  readonly resolveVerified: (id: OperationContext['scope']['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) => PreparationDeployment | undefined;
  readonly inputs: () => readonly OwnedUtxo[];
  readonly clock: MonotonicClock;
  readonly refreshDecision?: PaymentPreparationDependencies['refreshDecision'];
  readonly currentDecision?: PaymentPreparationDependencies['currentDecision'];
  readonly recovery: NonNullable<PaymentPorts['recovery']>;
  readonly reconciliation: NonNullable<PaymentPorts['reconciliation']>;
}

export interface BrowserPaymentBinding {
  readonly client: PaymentClient;
  refreshPay(prepared: PreparedPay): Promise<PreparedPay>;
  terms(prepared: PreparedPay): { readonly minAmountOut: bigint; readonly deadline: bigint };
  now(): number;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const sameScope = (left: Scope, right: Scope): boolean => left.deploymentId === right.deploymentId
  && same(left.owner, right.owner);
const validHash = (value: unknown): value is Bytes32 => typeof value === 'string'
  && /^0x[0-9a-fA-F]{64}$/.test(value);
function invalid(): never { throw new Error('INVALID_PAYMENT_DEPLOYMENT'); }
const uint64Max = (1n << 64n) - 1n;
function optionalMinimum(value: unknown): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('INVALID_PAYMENT_TERMS');
  try { return parseEthAmount(value); } catch { throw new Error('INVALID_PAYMENT_TERMS'); }
}
function optionalDeadline(value: unknown): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('INVALID_PAYMENT_TERMS');
  const deadline = BigInt(value);
  if (deadline > uint64Max) throw new Error('INVALID_PAYMENT_TERMS');
  return deadline;
}

/** Compose one captured payment action from verified deployments and real protocol adapters. */
export function createBrowserPaymentBinding(deps: BrowserPaymentDependencies): BrowserPaymentBinding {
  const { context, browser, deployment, verified, rpc } = deps;
  context.check();
  const scope = { ...context.scope };
  const current = deps.resolveDeployment(scope.deploymentId);
  const currentVerified = deps.resolveVerified(scope.deploymentId);
  if (!sameScope(scope, { deploymentId: browser.deploymentId, owner: scope.owner })
    || browser.chainId !== deployment.chainId || verified.context.chainId !== deployment.chainId
    || BigInt(verified.manifest.chainId) !== deployment.chainId
    || !same(browser.pool, deployment.pool) || !same(browser.adapter, deployment.adapter)
    || !same(verified.context.pool, deployment.pool) || !same(verified.manifest.pool.address, deployment.pool)
    || rpc.mode !== verified.context.finalityMode || deps.reconciliation.expectedChainId !== deployment.chainId
    || !current || current.chainId !== deployment.chainId || !same(current.pool, deployment.pool)
    || !same(current.adapter, deployment.adapter) || !same(current.router, deployment.router)
    || !same(current.factory, deployment.factory) || !same(current.weth, deployment.weth)
    || !same(current.token, deployment.token) || !same(current.pair, deployment.pair)
    || !currentVerified || currentVerified.context.chainId !== deployment.chainId
    || !same(currentVerified.context.pool, deployment.pool)) invalid();

  const quote = createBrowserQuoteReader({ context, rpc, verified, deployment,
    resolveDeployment: deps.resolveDeployment });
  const savedDecisions = createBrowserPaymentDecisions({ context, deployment,
    quoteReader: quote.quoteReader, latestBlockTime: quote.latestBlockTime, clock: deps.clock });
  const decisions = createPaymentDecisions({ scope, verified, deployment, inputs: deps.inputs,
    quoteReader: quote.quoteReader, latestBlockTime: quote.latestBlockTime, clock: deps.clock });
  const signedChangeRecipient = async () => {
    context.check();
    const unsigned = context.recipientInfo();
    const typed = recipientInfoTypedData(verified.context, unsigned, scope.owner);
    const signed = await context.typedSign(typed, 'recipient-info');
    context.check();
    if (signed.epoch !== context.epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED');
    const recipient = { ...unsigned, signature: signed.value as `0x${string}` };
    await verifyRecipientInfo(verified.context, recipient, scope.owner);
    context.check();
    return recipient;
  };
  const preparation = createPaymentPreparationPorts({ context,
    jobId: () => crypto.randomUUID(),
    payPlan: async raw => {
      context.check();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INPUT_INVALID');
      const input = raw as Record<string, unknown>;
      if (typeof input.amount !== 'string' || typeof input.recipient !== 'string'
        || !isAddress(input.recipient, { strict: false })) throw new Error('INPUT_INVALID');
      parseEthAmount(input.amount);
      const minimum = optionalMinimum(input.minAmountOut);
      const deadline = optionalDeadline(input.deadline);
      if (deadline !== undefined && deadline <= await quote.latestBlockTime()) throw new Error('INVALID_PAYMENT_TERMS');
      context.check();
      const plan = await decisions.payPlan({ amount: input.amount, recipient: input.recipient as Address,
        changeRecipient: await signedChangeRecipient() });
      context.check();
      if (minimum === undefined && deadline === undefined) return plan;
      return { payload: plan.payload, decide(draft) {
        const proposed = plan.decide(draft);
        if (proposed.kind !== 'pay') throw new Error('INVALID_PAYMENT_PREPARATION');
        const terms = { ...proposed.terms,
          minAmountOut: minimum ?? proposed.terms.minAmountOut,
          deadline: deadline ?? proposed.terms.deadline };
        return { ...proposed, terms, identity: { ...proposed.identity,
          contentHash: paymentContentHash(draft, terms, proposed.quote, deployment) } };
      } };
    },
    withdrawPlan: async raw => {
      context.check();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INPUT_INVALID');
      const id = (raw as Record<string, unknown>).utxoId;
      if (!validHash(id)) throw new Error('INPUT_INVALID');
      return decisions.withdrawPlan({ inputId: id });
    },
    refreshDecision: deps.refreshDecision ?? savedDecisions.refreshDecision,
    currentDecision: deps.currentDecision ?? savedDecisions.currentDecision,
  });
  const termsForSubmit: Parameters<typeof createPaymentSubmit>[0]['paymentTerms'] = prepared => {
    if (prepared.record.kind !== 'pay' || !('quote' in prepared)) throw new Error('INVALID_PAYMENT_PREPARATION');
    return preparation.paymentTerms(prepared as PreparedPay);
  };
  const submit = createPaymentSubmit({ context, rpc, resolveVerified: deps.resolveVerified,
    resolveDeployment: deps.resolveDeployment, paymentTerms: termsForSubmit });
  const reservations = createReservationPort(createHttpClient({ origin: browser.origin }));
  const client = createScopedPaymentClient({ context, resolveDeployment: deps.resolveDeployment,
    reservations, ...preparation, paymentTerms: termsForSubmit, clock: deps.clock, latestBlockTime: quote.latestBlockTime,
    createAttempt: () => crypto.randomUUID() as AttemptId, submit,
    recovery: deps.recovery, reconciliation: deps.reconciliation });
  return { client, refreshPay: preparation.refreshPay,
    terms(prepared) {
      const terms = preparation.paymentTerms(prepared);
      return { minAmountOut: terms.minAmountOut, deadline: terms.deadline };
    },
    now: () => { context.check(); return deps.clock.now(); } };
}
