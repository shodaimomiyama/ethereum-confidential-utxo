import type { VerifiedDeployment, RpcConnection } from '@confidential-utxo/ethereum';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import type { UiController, ViewState } from '../contracts/index.js';
import { createAuthSession, type AuthSession } from './auth.js';
import type { CipherCache } from './cache.js';
import { createLiveController } from './controller.js';
import type { BrowserDeployment } from './deployment.js';
import { createHttpClient, type HttpClient } from './http.js';
import { createKeySession } from './key-session.js';
import { createOperationPort, type OperationPortDependencies } from './operation-port.js';
import type { OperationContext } from './operations.js';
import { Recovery } from './recovery.js';
import { createRecoveryChainReader } from './recovery-chain.js';
import type { Eip1193Provider, WalletEvent, WalletPort } from './wallet.js';
import { createMetaMaskWallet } from './wallet.js';
import { CryptoWorkerClient } from './worker-client.js';

export interface LiveOperationBindings {
  readonly auth: AuthSession;
  readonly wallet: WalletPort;
  readonly http: HttpClient;
  readonly snapshot: () => ViewState;
  readonly resolveVerified: (id: Scope['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: Scope['deploymentId']) => BrowserDeployment | undefined;
  readonly rpc: RpcConnection;
}

export interface LiveBootstrapDependencies {
  /** Explicit scope selection; the owner is not inferred from an unconnected wallet. */
  readonly initialScope: Scope;
  readonly provider: Eip1193Provider;
  /** Both deployments must already have passed their respective independent verification steps. */
  readonly browser: BrowserDeployment;
  readonly verified: VerifiedDeployment;
  readonly rpc: RpcConnection;
  readonly operationDependencies: (bindings: LiveOperationBindings) =>
    Omit<OperationPortDependencies, 'snapshot' | 'resolveVerified'>;
  readonly cache?: CipherCache;
}

function initialState(scope: Scope): ViewState {
  const cards = Object.fromEntries(['reward', 'pay', 'deposit', 'withdraw'].map(card =>
    [card, { phase: 'needs-preparation', input: {} }])) as ViewState['cards'];
  return { scope, connection: 'disconnected', preparation: { wallet: false, network: false,
    key: false, faucet: false, gas: false }, utxos: [], selectedInput: {}, operationCards: {},
    operationActions: {}, publicEthWei: 0n, availablePrivateWei: 0n, pendingPrivateWei: 0n,
    isStale: true, storageAvailability: 'unavailable', cards, operations: [], rewardRequests: [],
    allowedActions: ['connect', 'switch-scope'], reasons: {} };
}

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function freezeData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (!plain(value)) throw new Error('DEPLOYMENT_MISMATCH');
  seen.add(value);
  for (const child of Object.values(value)) freezeData(child, seen);
  Object.freeze(value);
}

function sameData(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right);
  }
  if (!plain(left) || !plain(right) || Array.isArray(left) !== Array.isArray(right)) return false;
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], seen));
}

function pin<T>(value: T): T {
  try {
    const pinned = structuredClone(value);
    freezeData(pinned);
    if (!sameData(value, pinned)) throw new Error('DEPLOYMENT_MISMATCH');
    return pinned;
  } catch { throw new Error('DEPLOYMENT_MISMATCH'); }
}

/** Compose the live adapters only after the caller has verified and pinned deployment evidence. */
export function createLiveBootstrap(deps: LiveBootstrapDependencies): UiController {
  const { initialScope, rpc } = deps;
  const browser = pin(deps.browser);
  const verified = pin(deps.verified);
  let serviceOrigin: URL;
  let siweUri: URL;
  try { serviceOrigin = new URL(browser.origin); siweUri = new URL(browser.siweUri); }
  catch { throw new Error('DEPLOYMENT_MISMATCH'); }
  if (initialScope.deploymentId !== browser.deploymentId
    || !/^0x[0-9a-fA-F]{40}$/.test(initialScope.owner)
    || !/^0x[0-9a-fA-F]{40}$/.test(browser.pool)
    || !/^0x[0-9a-fA-F]{40}$/.test(browser.adapter)
    || verified.context.chainId !== browser.chainId
    || verified.context.pool.toLowerCase() !== browser.pool.toLowerCase()
    || BigInt(verified.manifest.chainId) !== browser.chainId
    || verified.manifest.pool.address.toLowerCase() !== browser.pool.toLowerCase()
    || serviceOrigin.protocol !== 'https:' || serviceOrigin.origin !== browser.origin
    || serviceOrigin.pathname !== '/' || serviceOrigin.search || serviceOrigin.hash
    || siweUri.origin !== browser.origin || siweUri.hash || siweUri.search
    || verified.context.finalityMode !== rpc.mode) throw new Error('DEPLOYMENT_MISMATCH');

  const unchanged = (): boolean => sameData(deps.browser, browser)
    && sameData(deps.verified, verified) && rpc.mode === verified.context.finalityMode;
  const resolveDeployment = (id: Scope['deploymentId']) => unchanged() && id === browser.deploymentId ? browser : undefined;
  const resolveVerified = (id: Scope['deploymentId']) => unchanged() && id === browser.deploymentId ? verified : undefined;
  const http = createHttpClient({ origin: browser.origin });
  const wallet = createMetaMaskWallet(deps.provider, browser.deploymentId, resolveDeployment);
  let connection: WalletEvent = { epoch: 0 };
  wallet.subscribe(event => { connection = event; });
  const worker = new CryptoWorkerClient();
  const auth = createAuthSession({ client: http, wallet, origin: browser.origin,
    resolveDeployment, connection: () => connection });
  let controller: UiController | undefined;
  const snapshot = (): ViewState => controller?.snapshot() ?? initialState(initialScope);
  const bindings: LiveOperationBindings = { auth, wallet, http, snapshot, resolveVerified, resolveDeployment, rpc };
  try {
    const operations = createOperationPort({ ...deps.operationDependencies(bindings), snapshot,
      resolveVerified: id => {
        const current = resolveVerified(id);
        return current ? { deploymentId: id, verified: current } : undefined;
      } });
    const createRecovery = (context: OperationContext): Recovery => new Recovery({ http,
      chain: createRecoveryChainReader({ context, rpc, resolveVerified }), cache: deps.cache,
      chainId: browser.chainId, pool: browser.pool as Address });
    controller = createLiveController({ initialState: initialState(initialScope), wallet, worker, operations,
      auth, createRecovery, resolveDeployment, connection: () => connection,
      createKeySession: active => createKeySession(wallet, active, browser) });
  } catch (error) {
    auth.dispose(); worker.dispose(); wallet.dispose();
    throw error;
  }
  return controller;
}
