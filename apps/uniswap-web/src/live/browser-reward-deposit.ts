import type { ReceiptKeyPort } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { DeploymentId, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../contracts/index.js';
import type { AuthSession } from './auth.js';
import { createDepositOperation, type DepositOperation } from './deposit-operation.js';
import { createIndexedDbDepositStorage } from './deposit-storage.js';
import { createIndexedDbDepositAttemptGate, createIndexedDbRewardRequestMarker } from './durable-markers.js';
import type { BrowserDeployment, createDeploymentResolver } from './deployment.js';
import { createHttpClient } from './http.js';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { createScopedRewardClient } from './reward-client.js';
import { createRewardOperation, type RewardOperation } from './reward-operation.js';

export interface BrowserRewardDepositDependencies {
  readonly snapshot: () => ViewState;
  /** Pinned site manifest resolver, created only after independent deployment verification. */
  readonly resolveDeployment: ReturnType<typeof createDeploymentResolver>;
  readonly resolveVerified: (id: DeploymentId) => VerifiedDeployment | undefined;
  readonly rpc: RpcConnection;
  readonly auth: Pick<AuthSession, 'isAuthenticated'>;
  /** Scoped worker-backed receipt key adapter; there is no browser default. */
  readonly receiptKeys: (context: OperationContext) => ReceiptKeyPort;
  readonly indexedDb?: IDBFactory | null;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function matching(browser: BrowserDeployment, verified: VerifiedDeployment, rpc: RpcConnection): boolean {
  return browser.chainId === verified.context.chainId
    && browser.chainId === BigInt(verified.manifest.chainId)
    && same(browser.pool, verified.context.pool)
    && same(browser.pool, verified.manifest.pool.address)
    && verified.context.finalityMode === rpc.mode;
}

function sameBrowser(left: BrowserDeployment, right: BrowserDeployment): boolean {
  return left.deploymentId === right.deploymentId && left.chainId === right.chainId
    && same(left.pool, right.pool) && same(left.adapter, right.adapter)
    && left.origin === right.origin && left.siweUri === right.siweUri;
}

/** Bind reward and deposit to one independently verified deployment and real browser storage. */
export function createBrowserRewardDepositSuppliers(deps: BrowserRewardDepositDependencies): {
  readonly reward: RewardOperation;
  readonly deposit: DepositOperation;
} {
  const selected = deps.snapshot().scope.deploymentId;
  const initialBrowser = deps.resolveDeployment(selected);
  const initialVerified = deps.resolveVerified(selected);
  if (!initialBrowser || !initialVerified || initialBrowser.deploymentId !== selected
    || !matching(initialBrowser, initialVerified, deps.rpc)) throw new Error('DEPLOYMENT_MISMATCH');
  const browser = Object.freeze({ ...initialBrowser });
  const http = createHttpClient({ origin: browser.origin });
  const marker = createIndexedDbRewardRequestMarker(deps.indexedDb);
  const attempts = createIndexedDbDepositAttemptGate(deps.indexedDb);

  function current(id: DeploymentId): { browser: BrowserDeployment; verified: VerifiedDeployment } {
    const location = deps.resolveDeployment(id);
    const verified = deps.resolveVerified(id);
    if (id !== selected || !location || !verified || !sameBrowser(location, browser)
      || !matching(location, verified, deps.rpc)) throw new Error('SCOPE_CHANGED');
    return { browser: location, verified };
  }
  function checkedContext(context: OperationContext): VerifiedDeployment {
    context.check();
    if (!sameScope(context.scope, deps.snapshot().scope)) throw new Error('SCOPE_CHANGED');
    return current(context.scope.deploymentId).verified;
  }

  const reward = createRewardOperation({ snapshot: deps.snapshot, marker,
    client: context => {
      checkedContext(context);
      return createScopedRewardClient({ context, http, auth: deps.auth,
        resolveDeployment: id => current(id).browser });
    } });
  const deposit = createDepositOperation({ snapshot: deps.snapshot,
    createDependencies: context => {
      const verified = checkedContext(context);
      const key = context.recordKey();
      context.check();
      const keys = deps.receiptKeys(context);
      context.check();
      return { rpc: deps.rpc, resolveVerified: id => current(id).verified,
        storage: createIndexedDbDepositStorage({ scope: context.scope, context: verified.context,
          key, factory: deps.indexedDb }), keys, attempts };
    } });
  return { reward, deposit };
}
