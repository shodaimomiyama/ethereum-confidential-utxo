import type { Scope } from '@confidential-utxo/uniswap';
import { zeroAddress } from 'viem';
import type { UiController } from '../contracts/index.js';
import type { SiteConfig } from '../site/config.js';
import { createLiveBootstrap, type LiveOperationBindings } from './bootstrap.js';
import { loadBrowserLiveConfig } from './browser-config.js';
import { createBrowserOperationActions } from './browser-operation-actions.js';
import { createBrowserOperationDependencies } from './browser-operations.js';
import { createBrowserPaymentReconciliation } from './browser-payment-reconciliation.js';
import { createBrowserPaymentRecovery } from './browser-payment-recovery.js';
import { createBrowserPublicBalanceReader } from './public-balance.js';
import { createBrowserQuoteReader } from './quote-reader.js';
import { createBrowserReadiness } from './browser-readiness.js';
import { createScopedEthereumBridge } from './ethereum.js';
import type { Eip1193Provider } from './wallet.js';
import { createWorkerReceiptKeyPort } from './receipt-worker.js';
import { createReservationPort } from './reservations.js';

const monotonicClock = { now: () => performance.timeOrigin + performance.now() };

/** Build the live controller from the browser's pinned manifest and MetaMask provider. */
export async function createBrowserLiveController(config: SiteConfig): Promise<UiController> {
  if (config.mode !== 'live') throw new Error('LIVE_MODE_REQUIRED');
  if (!config.liveConfigUrl || !config.liveConfigSha256) throw new Error('LIVE_CONFIG_REQUIRED');
  const loaded = await loadBrowserLiveConfig({ url: config.liveConfigUrl,
    expectedSha256: config.liveConfigSha256 });
  if (loaded.browser.deploymentId !== config.deploymentId) throw new Error('DEPLOYMENT_MISMATCH');
  const provider = (window as Window & { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
  if (!provider || provider.isMetaMask !== true || typeof provider.request !== 'function'
    || typeof provider.on !== 'function' || typeof provider.removeListener !== 'function') {
    throw new Error('METAMASK_UNAVAILABLE');
  }
  const initialScope: Scope = { deploymentId: loaded.browser.deploymentId,
    owner: zeroAddress as Scope['owner'] };
  return createLiveBootstrap({ initialScope, provider, browser: loaded.browser,
    verified: loaded.verified, rpc: loaded.rpc,
    operationDependencies(bindings: LiveOperationBindings) {
      const readiness = createBrowserReadiness({
        resolveVerified: bindings.resolveVerified,
        resolvePaymentDeployment: loaded.resolveDeployment,
        clock: monotonicClock,
        quote(context) {
          const verified = bindings.resolveVerified(context.scope.deploymentId);
          const deployment = loaded.resolveDeployment(context.scope.deploymentId);
          if (!verified || !deployment) throw new Error('SCOPE_CHANGED');
          const source = createBrowserQuoteReader({ context, rpc: bindings.rpc, verified,
            deployment, resolveDeployment: loaded.resolveDeployment });
          return { reader: source.quoteReader, latestBlockTime: source.latestBlockTime };
        },
        async publicEth(context) {
          const verified = bindings.resolveVerified(context.scope.deploymentId);
          if (!verified) throw new Error('SCOPE_CHANGED');
          const balance = createBrowserPublicBalanceReader({ context, rpc: bindings.rpc, verified,
            resolveDeployment: loaded.resolveDeployment });
          return (await balance.read()).wei;
        },
      });
      const reconciliation = (context: Parameters<typeof createBrowserPaymentReconciliation>[0]['context']) =>
        createBrowserPaymentReconciliation({ context, rpc: bindings.rpc,
          verified: loaded.verified, deployment: loaded.deployment,
          resolveVerified: bindings.resolveVerified, resolveDeployment: loaded.resolveDeployment });
      const recovery = (context: Parameters<typeof createBrowserPaymentRecovery>[0]['context']) =>
        createBrowserPaymentRecovery({ context, rpc: bindings.rpc, verified: loaded.verified,
          browser: loaded.browser, deployment: loaded.deployment,
          resolveVerified: bindings.resolveVerified, resolveDeployment: loaded.resolveDeployment,
          reconciliation: reconciliation(context) });
      let actions: ReturnType<typeof createBrowserOperationActions> | undefined;
      const operationDependencies = createBrowserOperationDependencies(bindings, {
        paymentDeployment: loaded.deployment, resolvePaymentDeployment: loaded.resolveDeployment,
        clock: monotonicClock, paymentRecovery: recovery, paymentReconciliation: reconciliation,
        evaluateReady: readiness.evaluateReady, evaluateDraft: readiness.evaluateDraft,
        recheck: (...args) => actions!.recheck(...args),
        resumeOriginal: (...args) => actions!.resumeOriginal(...args),
        retryAttempt: (...args) => actions!.retryAttempt(...args),
        receive: (...args) => actions!.receive(...args),
      });
      actions = createBrowserOperationActions({ snapshot: bindings.snapshot,
        resolveVerified: bindings.resolveVerified,
        history: context => createScopedEthereumBridge({ context, rpc: bindings.rpc,
          resolveVerified: bindings.resolveVerified }).history,
        receiptKeys: createWorkerReceiptKeyPort,
        reservations: context => { context.check(); return createReservationPort(bindings.http); },
        payment: context => operationDependencies.payment(context),
        paymentRecovery: recovery, reward: operationDependencies.reward });
      return operationDependencies;
    },
  });
}
