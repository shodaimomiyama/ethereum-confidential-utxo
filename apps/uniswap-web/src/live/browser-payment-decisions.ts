import type { LocalDraft } from '@confidential-utxo/core';
import type { PreparedFullWithdraw, PreparedPay, PaymentTerms, MonotonicClock } from '@confidential-utxo/uniswap';
import { defaultTerms, fetchPayQuote, isQuoteFresh } from '@confidential-utxo/uniswap';
import type { QuoteReader } from '@confidential-utxo/uniswap';
import type { OperationContext } from './operations.js';
import { decodePaymentPrivateRecord } from './payment-record.js';
import { paymentContentHash, type PreparationDecision, type PreparationDeployment } from './payment-preparation.js';

export interface BrowserPaymentDecisionDependencies {
  readonly context: OperationContext;
  readonly deployment: PreparationDeployment;
  readonly quoteReader: QuoteReader;
  readonly latestBlockTime: () => Promise<bigint>;
  readonly clock: MonotonicClock;
}

/** Reconstructs the exact saved authorization and refreshes a Pay without changing its core operation. */
export function createBrowserPaymentDecisions(deps: BrowserPaymentDecisionDependencies) {
  const scope = { ...deps.context.scope };
  const location = { ...deps.deployment };
  const check = () => {
    deps.context.check();
    if (deps.context.scope.deploymentId !== scope.deploymentId
      || deps.context.scope.owner.toLowerCase() !== scope.owner.toLowerCase()
      || deps.deployment.chainId !== location.chainId
      || deps.deployment.pool.toLowerCase() !== location.pool.toLowerCase()
      || deps.deployment.adapter.toLowerCase() !== location.adapter.toLowerCase()) throw new Error('SCOPE_CHANGED');
  };
  function exact(prepared: PreparedPay | PreparedFullWithdraw, draft: LocalDraft): PreparationDecision {
    check();
    const plain = decodePaymentPrivateRecord(prepared.privateBytes);
    if (plain.operationId !== draft.operationId || plain.binding.recordId !== prepared.record.recordId
      || plain.binding.operationId !== prepared.record.operationId
      || plain.binding.scope.deploymentId !== scope.deploymentId
      || plain.binding.scope.owner.toLowerCase() !== scope.owner.toLowerCase()
      || draft.context.chainId !== location.chainId || draft.context.pool.toLowerCase() !== location.pool.toLowerCase()) {
      throw new Error('INVALID_PAYMENT_DECISION');
    }
    const identity = { scope, recordId: prepared.record.recordId, contentHash: prepared.record.contentHash };
    if (prepared.record.kind === 'withdraw') {
      if (plain.binding.kind !== 'withdraw') throw new Error('INVALID_PAYMENT_DECISION');
      return { kind: 'withdraw', identity, deployment: location };
    }
    if (plain.binding.kind !== 'pay' || !plain.quote || !('quote' in prepared)) throw new Error('INVALID_PAYMENT_DECISION');
    const message = (plain.intendedAuthorization.payment as { message?: PaymentTerms } | undefined)?.message;
    if (!message || message.operationId !== draft.operationId || message.owner.toLowerCase() !== scope.owner.toLowerCase()
      || message.token.toLowerCase() !== location.token.toLowerCase() || message.ethAmount !== draft.request.w
      || message.deadline !== prepared.record.deadline) throw new Error('INVALID_PAYMENT_DECISION');
    if (paymentContentHash(draft, message, plain.quote, location) !== prepared.record.contentHash) {
      throw new Error('INVALID_PAYMENT_DECISION');
    }
    return { kind: 'pay', identity, deployment: location, terms: message, quote: plain.quote };
  }
  return {
    currentDecision: exact,
    async refreshDecision(prepared: PreparedPay, draft: LocalDraft): Promise<PreparationDecision> {
      const prior = exact(prepared, draft);
      if (prior.kind !== 'pay' || prepared.record.signatureStarted || prepared.record.attemptIds.length !== 0) {
        throw new Error('INVALID_PAYMENT_DECISION');
      }
      const quote = await fetchPayQuote(deps.quoteReader, draft.request.w,
        { weth: location.weth, dusd: location.token }, deps.clock);
      check();
      const blockTime = await deps.latestBlockTime();
      check();
      if (!isQuoteFresh(quote, deps.clock.now())) throw new Error('QUOTE_STALE');
      const defaults = defaultTerms(quote, blockTime);
      const terms = { ...prior.terms, minAmountOut: defaults.minAmountOut, deadline: defaults.deadline };
      return { kind: 'pay', deployment: location, quote, terms,
        identity: { scope, recordId: prepared.record.recordId,
          contentHash: paymentContentHash(draft, terms, quote, location) } };
    },
  };
}
