import { describe, expect, it } from 'vitest';
import type { VerifiedDeployment, RpcConnection } from '@confidential-utxo/ethereum';
import type { Scope } from '@confidential-utxo/uniswap';
import { createLiveBootstrap, type LiveOperationBindings } from '../../src/live/bootstrap.js';
import type { BrowserDeployment } from '../../src/live/deployment.js';
import type { OperationPortDependencies } from '../../src/live/operation-port.js';
import type { Eip1193Provider } from '../../src/live/wallet.js';

const pool = `0x${'11'.repeat(20)}` as const;
const adapter = `0x${'22'.repeat(20)}` as const;
const owner = `0x${'33'.repeat(20)}` as const;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const browser: BrowserDeployment = { deploymentId: scope.deploymentId, chainId: 31337n,
  pool, adapter, origin: 'https://wallet.example.test', siweUri: 'https://wallet.example.test/login' };
const verified = { context: { chainId: 31337n, pool, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: pool } } } as VerifiedDeployment;
const rpc = { mode: 'local-simulated' } as RpcConnection;

function fixture() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider: Eip1193Provider = {
    async request({ method }) {
      if (method === 'eth_requestAccounts') return [owner];
      if (method === 'eth_chainId') return '0x7a69';
      throw new Error(`Unexpected wallet method: ${method}`);
    },
    on(event, listener) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const unused = () => { throw new Error('Not exercised by this test'); };
  const operations = {
    payment: unused, reward: { start: unused, recheck: unused, list: unused, receive: unused },
    deposit: { prepareDeposit: unused, completePreparation: unused, authorize: unused },
    coreSync: unused, recheck: unused, resumeOriginal: unused, retryAttempt: unused, receive: unused,
  } as unknown as Omit<OperationPortDependencies, 'snapshot' | 'resolveVerified'>;
  return { provider, operations, emit(event: string, ...args: unknown[]) {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  }, listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0) };
}

describe('live bootstrap', () => {
  it('creates operation suppliers with the same auth session and live controller snapshot', async () => {
    const f = fixture();
    let supplied: LiveOperationBindings | undefined;
    const controller = createLiveBootstrap({ initialScope: scope, provider: f.provider, browser,
      verified, rpc, operationDependencies: ports => { supplied = ports; return f.operations; } });
    expect(supplied).toBeDefined();
    expect(supplied!.snapshot().connection).toBe('disconnected');
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'accepted' });
    expect(supplied!.snapshot().currentScope).toEqual(scope);
    expect(supplied!.resolveVerified(scope.deploymentId)).toEqual(verified);
    controller.dispose();
  });
  it('starts disconnected and connects the real wallet through the operation port', async () => {
    const f = fixture();
    const controller = createLiveBootstrap({ initialScope: scope, provider: f.provider, browser,
      verified, rpc, operationDependencies: () => f.operations });
    expect(controller.snapshot().connection).toBe('disconnected');
    expect(controller.snapshot().allowedActions).not.toContain('start:pay');
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'accepted' });
    expect(controller.snapshot().currentScope).toEqual(scope);
    expect(controller.snapshot().preparation).toMatchObject({ wallet: true, network: true, key: false });
    controller.dispose();
    expect(f.listenerCount()).toBe(0);
  });

  it('refuses a browser deployment that disagrees with verified on-chain context', () => {
    const f = fixture();
    expect(() => createLiveBootstrap({ initialScope: scope, provider: f.provider,
      browser: { ...browser, pool: adapter }, verified, rpc,
      operationDependencies: () => f.operations }))
      .toThrow('DEPLOYMENT_MISMATCH');
    expect(f.listenerCount()).toBe(0);
  });

  it('refuses a service origin and SIWE URI from different origins before attaching wallet listeners', () => {
    const f = fixture();
    expect(() => createLiveBootstrap({ initialScope: scope, provider: f.provider,
      browser: { ...browser, siweUri: 'https://other.example.test/login' }, verified, rpc,
      operationDependencies: () => f.operations }))
      .toThrow('DEPLOYMENT_MISMATCH');
    expect(f.listenerCount()).toBe(0);
  });

  it('blocks wallet connection if the browser adapter changes after bootstrap', async () => {
    const f = fixture();
    const mutableBrowser = { ...browser };
    const controller = createLiveBootstrap({ initialScope: scope, provider: f.provider,
      browser: mutableBrowser, verified, rpc, operationDependencies: () => f.operations });
    Object.assign(mutableBrowser, { adapter: pool });
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'blocked', reason: 'SERVICE_UNAVAILABLE' });
    expect(controller.snapshot().connection).toBe('disconnected');
    controller.dispose();
  });

  it('blocks wallet connection if the verified pool changes after bootstrap', async () => {
    const f = fixture();
    const mutableVerified = structuredClone(verified);
    const controller = createLiveBootstrap({ initialScope: scope, provider: f.provider,
      browser, verified: mutableVerified, rpc, operationDependencies: () => f.operations });
    Object.assign(mutableVerified.manifest.pool, { address: adapter });
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'blocked', reason: 'SERVICE_UNAVAILABLE' });
    expect(controller.snapshot().connection).toBe('disconnected');
    controller.dispose();
  });
});
