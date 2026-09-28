import type { OwnedUtxo, SyncResult as CoreSyncResult } from '@confidential-utxo/core';
import { createScopedEthereumBridge } from './ethereum.js';
import type { PaymentPorts } from '@confidential-utxo/uniswap';
import { sameScope } from './http.js';
import type { LiveOperationBindings } from './bootstrap.js';
import { createBrowserPaymentBinding } from './browser-payment.js';
import { createBrowserRewardDepositSuppliers } from './browser-reward-deposit.js';
import type { OperationPortDependencies } from './operation-port.js';
import type { OperationContext } from './operations.js';
import type { PaymentPreparationDependencies, PreparationDeployment } from './payment-preparation.js';
import { createWorkerReceiptKeyPort } from './receipt-worker.js';

type CompleteCore = Extract<CoreSyncResult, { status: 'complete' }>;
type Action = Parameters<OperationPortDependencies['recheck']>;

export interface BrowserOperationOptions {
  readonly paymentDeployment: PreparationDeployment;
  readonly resolvePaymentDeployment: (id: OperationContext['scope']['deploymentId']) => PreparationDeployment | undefined;
  readonly clock: Parameters<typeof createBrowserPaymentBinding>[0]['clock'];
  readonly refreshDecision?: PaymentPreparationDependencies['refreshDecision'];
  readonly currentDecision?: PaymentPreparationDependencies['currentDecision'];
  readonly paymentRecovery: (context: OperationContext) => NonNullable<PaymentPorts['recovery']>;
  readonly paymentReconciliation: (context: OperationContext) => NonNullable<PaymentPorts['reconciliation']>;
  readonly evaluateReady: NonNullable<OperationPortDependencies['recomputeReady']>;
  readonly evaluateDraft: NonNullable<OperationPortDependencies['evaluateDraft']>;
  readonly recheck: OperationPortDependencies['recheck'];
  readonly resumeOriginal: OperationPortDependencies['resumeOriginal'];
  readonly retryAttempt: OperationPortDependencies['retryAttempt'];
  readonly receive: OperationPortDependencies['receive'];
  readonly indexedDb?: IDBFactory | null;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const fingerprint = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? ['bigint', item.toString()] : item);

/** Real browser adapters; business decisions are required explicitly from their evidence suppliers. */
export function createBrowserOperationDependencies(bindings: LiveOperationBindings,
  options: BrowserOperationOptions): Omit<OperationPortDependencies, 'snapshot' | 'resolveVerified'> {
  const selected = bindings.snapshot().scope.deploymentId;
  const browser = bindings.resolveDeployment(selected);
  const verified = bindings.resolveVerified(selected);
  const paymentDeployment = options.resolvePaymentDeployment(selected);
  if (!browser || !verified || !paymentDeployment || browser.deploymentId !== selected
    || verified.context.chainId !== browser.chainId || !same(verified.context.pool, browser.pool)
    || verified.context.finalityMode !== bindings.rpc.mode
    || paymentDeployment.chainId !== browser.chainId || !same(paymentDeployment.pool, browser.pool)
    || !same(paymentDeployment.adapter, browser.adapter)
    || fingerprint(paymentDeployment) !== fingerprint(options.paymentDeployment)) throw new Error('DEPLOYMENT_MISMATCH');

  const pinnedBrowser = structuredClone(browser);
  const pinnedVerified = structuredClone(verified);
  const pinnedPayment = structuredClone(paymentDeployment);
  const browserSignature = fingerprint(pinnedBrowser);
  const verifiedSignature = fingerprint(pinnedVerified);
  const paymentSignature = fingerprint(pinnedPayment);
  let cached: { readonly scope: OperationContext['scope']; readonly epoch: number; readonly core: CompleteCore } | undefined;
  function checkAction(scope: OperationContext['scope'], context: OperationContext): void {
    try { context.check(); } catch (error) { cached = undefined; throw error; }
    const current = bindings.resolveVerified(scope.deploymentId);
    const location = bindings.resolveDeployment(scope.deploymentId);
    const payment = options.resolvePaymentDeployment(scope.deploymentId);
    if (!sameScope(scope, context.scope) || !sameScope(scope, bindings.snapshot().scope)
      || scope.deploymentId !== selected || !current || !location || !payment
      || fingerprint(current) !== verifiedSignature
      || fingerprint(location) !== browserSignature
      || fingerprint(payment) !== paymentSignature
      || bindings.rpc.mode !== pinnedVerified.context.finalityMode) {
      cached = undefined;
      throw new Error('SCOPE_CHANGED');
    }
  }
  function inputs(context: OperationContext): readonly OwnedUtxo[] {
    checkAction(context.scope, context);
    const view = bindings.snapshot();
    if (view.isStale || view.storageAvailability !== 'healthy' || !cached
      || cached.epoch !== context.epoch || !sameScope(cached.scope, context.scope)) {
      cached = undefined;
      return [];
    }
    return structuredClone(cached.core.utxos.filter(coin => coin.status === 'available'));
  }

  const { reward, deposit } = createBrowserRewardDepositSuppliers({ snapshot: bindings.snapshot,
    resolveDeployment: bindings.resolveDeployment, resolveVerified: bindings.resolveVerified,
    rpc: bindings.rpc, auth: bindings.auth, receiptKeys: createWorkerReceiptKeyPort,
    indexedDb: options.indexedDb });

  return {
    payment(context) {
      checkAction(context.scope, context);
      const recovery = options.paymentRecovery(context);
      checkAction(context.scope, context);
      const reconciliation = options.paymentReconciliation(context);
      checkAction(context.scope, context);
      return createBrowserPaymentBinding({ context, rpc: bindings.rpc, verified: pinnedVerified,
        browser: pinnedBrowser, deployment: pinnedPayment,
        resolveVerified: bindings.resolveVerified, resolveDeployment: options.resolvePaymentDeployment,
        inputs: () => inputs(context), clock: options.clock,
        ...(options.refreshDecision ? { refreshDecision: async (...args: Parameters<NonNullable<typeof options.refreshDecision>>) => {
          checkAction(context.scope, context);
          const decision = await options.refreshDecision!(...args);
          checkAction(context.scope, context);
          return decision;
        } } : {}),
        ...(options.currentDecision ? { currentDecision: (...args: Parameters<NonNullable<typeof options.currentDecision>>) => {
          checkAction(context.scope, context);
          const decision = options.currentDecision!(...args);
          checkAction(context.scope, context);
          return decision;
        } } : {}),
        recovery, reconciliation });
    },
    reward, deposit,
    coreSync(scope, context, supplied) {
      checkAction(scope, context);
      if (fingerprint(supplied) !== verifiedSignature) throw new Error('SCOPE_CHANGED');
      const bridge = createScopedEthereumBridge({ context, rpc: bindings.rpc,
        resolveVerified: bindings.resolveVerified });
      const view = bindings.snapshot();
      const previousCore = !view.isStale && view.storageAvailability === 'healthy'
        && cached?.epoch === context.epoch && sameScope(cached.scope, scope) ? cached.core : undefined;
      if (!previousCore) cached = undefined;
      return { deploymentId: selected, coreContext: pinnedVerified.context, history: bridge.history,
        keys: createWorkerReceiptKeyPort(context), ...(previousCore ? { previousCore } : {}) };
    },
    async recomputeReady(evidence) {
      checkAction(evidence.scope, evidence.context);
      if (evidence.core.status !== 'complete' || evidence.recovered.availability !== 'healthy'
        || evidence.view.isStale || evidence.view.storageAvailability !== 'healthy') throw new Error('SCOPE_CHANGED');
      const next = { scope: { ...evidence.scope }, epoch: evidence.context.epoch,
        core: structuredClone(evidence.core) };
      cached = next;
      try {
        const ready = await options.evaluateReady(evidence);
        checkAction(evidence.scope, evidence.context);
        return ready;
      } catch (error) { if (cached === next) cached = undefined; throw error; }
    },
    async evaluateDraft(evidence) {
      checkAction(evidence.scope, evidence.context);
      const ready = await options.evaluateDraft(evidence);
      checkAction(evidence.scope, evidence.context);
      return ready;
    },
    async recheck(...args: Action) {
      checkAction(args[0], args[2]); const result = await options.recheck(...args);
      checkAction(args[0], args[2]); return result;
    },
    async resumeOriginal(...args: Action) {
      checkAction(args[0], args[2]); const result = await options.resumeOriginal(...args);
      checkAction(args[0], args[2]); return result;
    },
    async retryAttempt(...args: Action) {
      checkAction(args[0], args[2]); const result = await options.retryAttempt(...args);
      checkAction(args[0], args[2]); return result;
    },
    async receive(...args: Action) {
      checkAction(args[0], args[2]); const result = await options.receive(...args);
      checkAction(args[0], args[2]); return result;
    },
  };
}
