// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserLiveController } from '../../src/live/browser-composition.js';
import { loadBrowserLiveConfig } from '../../src/live/browser-config.js';

vi.mock('../../src/live/browser-config.js', () => ({ loadBrowserLiveConfig: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); delete (window as Window & { ethereum?: unknown }).ethereum; });

it('requires an exact pinned config before constructing any live ports', async () => {
  await expect(createBrowserLiveController({ mode: 'live', deploymentId: 'local-v1' }))
    .rejects.toThrow('LIVE_CONFIG_REQUIRED');
  expect(loadBrowserLiveConfig).not.toHaveBeenCalled();
});

it('rejects a different verified deployment before wallet construction', async () => {
  vi.mocked(loadBrowserLiveConfig).mockResolvedValue({ browser: { deploymentId: 'other-v1' } } as never);
  await expect(createBrowserLiveController({ mode: 'live', deploymentId: 'local-v1',
    liveConfigUrl: '/live-config.json', liveConfigSha256: 'ab'.repeat(32) }))
    .rejects.toThrow('DEPLOYMENT_MISMATCH');
});

it('requires MetaMask after deployment verification', async () => {
  vi.mocked(loadBrowserLiveConfig).mockResolvedValue({ browser: { deploymentId: 'local-v1' } } as never);
  await expect(createBrowserLiveController({ mode: 'live', deploymentId: 'local-v1',
    liveConfigUrl: '/live-config.json', liveConfigSha256: 'ab'.repeat(32) }))
    .rejects.toThrow('METAMASK_UNAVAILABLE');
});

it('creates the real controller for live /app and connects the selected MetaMask account', async () => {
  const owner = `0x${'11'.repeat(20)}`;
  const pool = `0x${'22'.repeat(20)}`;
  const adapter = `0x${'33'.repeat(20)}`;
  const browser = { deploymentId: 'local-v1', chainId: 31337n, pool, adapter,
    origin: 'https://local.invalid', siweUri: 'https://local.invalid/app' };
  const deployment = { chainId: 31337n, pool, adapter, token: `0x${'44'.repeat(20)}`,
    router: `0x${'55'.repeat(20)}`, factory: `0x${'66'.repeat(20)}`,
    weth: `0x${'77'.repeat(20)}`, pair: `0x${'88'.repeat(20)}` };
  const verified = { context: { chainId: 31337n, pool, deploymentBlock: 1n,
    verifier: `0x${'99'.repeat(20)}`, parametersHash: `0x${'aa'.repeat(32)}`,
    finalityMode: 'local-simulated' }, manifest: { chainId: 31337, pool: { address: pool } } };
  vi.mocked(loadBrowserLiveConfig).mockResolvedValue({ browser, deployment, verified,
    rpc: { mode: 'local-simulated', client: {}, policy: {} },
    resolveDeployment: () => deployment,
    resolveVerified: () => verified,
    resolveBrowser: () => browser } as never);
  const listeners = new Map<string, (...args: unknown[]) => void>();
  (window as Window & { ethereum?: unknown }).ethereum = {
    isMetaMask: true,
    request: async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [owner]
      : method === 'eth_chainId' ? '0x7a69' : undefined,
    on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
    removeListener: (event: string) => { listeners.delete(event); },
  };
  const controller = await createBrowserLiveController({ mode: 'live', deploymentId: 'local-v1',
    liveConfigUrl: '/live-config.json', liveConfigSha256: 'ab'.repeat(32) });
  try {
    expect(controller.snapshot().connection).toBe('disconnected');
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'accepted' });
    expect(controller.snapshot()).toMatchObject({ connection: 'connected', scope: { deploymentId: 'local-v1', owner } });
    expect(controller.snapshot().allowedActions).toContain('prepare-key');
  } finally { controller.dispose(); }
  expect(listeners.size).toBe(0);
});

it('offers network switching after connecting MetaMask on another chain', async () => {
  const owner = `0x${'11'.repeat(20)}`;
  const pool = `0x${'22'.repeat(20)}`;
  const browser = { deploymentId: 'local-v1', chainId: 31337n, pool, adapter: `0x${'33'.repeat(20)}`,
    origin: 'https://local.invalid', siweUri: 'https://local.invalid/app' };
  const deployment = { chainId: 31337n, pool, adapter: browser.adapter,
    token: `0x${'44'.repeat(20)}`, router: `0x${'55'.repeat(20)}`,
    factory: `0x${'66'.repeat(20)}`, weth: `0x${'77'.repeat(20)}`, pair: `0x${'88'.repeat(20)}` };
  const verified = { context: { chainId: 31337n, pool, deploymentBlock: 1n,
    verifier: `0x${'99'.repeat(20)}`, parametersHash: `0x${'aa'.repeat(32)}`,
    finalityMode: 'local-simulated' }, manifest: { chainId: 31337, pool: { address: pool } } };
  vi.mocked(loadBrowserLiveConfig).mockResolvedValue({ browser, deployment, verified,
    rpc: { mode: 'local-simulated', client: {}, policy: {} },
    resolveDeployment: () => deployment, resolveVerified: () => verified } as never);
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let chain = '0x1';
  (window as Window & { ethereum?: unknown }).ethereum = {
    isMetaMask: true,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') return [owner];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        chain = (params?.[0] as { chainId: string }).chainId;
        listeners.get('chainChanged')?.(chain);
        return null;
      }
      return undefined;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
    removeListener: (event: string) => { listeners.delete(event); },
  };
  const controller = await createBrowserLiveController({ mode: 'live', deploymentId: 'local-v1',
    liveConfigUrl: '/live-config.json', liveConfigSha256: 'ab'.repeat(32) });
  try {
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' });
    expect(controller.snapshot()).toMatchObject({ scope: { owner }, preparation: { wallet: true, network: false } });
    expect(controller.snapshot().allowedActions).toContain('switch-network');
    expect(await controller.dispatch({ type: 'switch-network' })).toEqual({ kind: 'accepted' });
    expect(controller.snapshot()).toMatchObject({ scope: { owner }, preparation: { wallet: true, network: true } });
    expect(controller.snapshot().allowedActions).toContain('prepare-key');
  } finally { controller.dispose(); }
});
