import { expect, it, vi } from 'vitest';
import { sha256, toBytes } from 'viem';
import uniswapV2 from '../../../../packages/ethereum/generated/uniswap-v2.json' with { type: 'json' };
import adapterArtifact from '../../../../packages/ethereum/generated/uniswap-payment-v1.json' with { type: 'json' };
import { loadBrowserLiveConfig } from '../../src/live/browser-config.js';

const ethereum = vi.hoisted(() => ({ createEthereumRpc: vi.fn(), verifyEthereumDeployment: vi.fn() }));
vi.mock('@confidential-utxo/ethereum', async importOriginal => ({
  ...await importOriginal<typeof import('@confidential-utxo/ethereum')>(), ...ethereum,
}));

const origin = 'https://demo.invalid';
const configUrl = `${origin}/live-config.json`;

it('rejects a cross-origin configuration URL before making a request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('location', { origin, href: `${origin}/app` });
  vi.stubGlobal('fetch', fetcher);
  await expect(loadBrowserLiveConfig({ url: 'https://elsewhere.invalid/live-config.json',
    expectedSha256: 'a'.repeat(64) })).rejects.toThrow('INVALID_LIVE_CONFIG');
  expect(fetcher).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('rejects a same-origin JSON body whose bytes differ from the independent pin', async () => {
  vi.stubGlobal('location', { origin, href: `${origin}/app` });
  const response = new Response('{"schemaVersion":1}', { headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: configUrl });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(loadBrowserLiveConfig({ url: configUrl, expectedSha256: 'b'.repeat(64) }))
    .rejects.toThrow('LIVE_CONFIG_HASH_MISMATCH');
  vi.unstubAllGlobals();
});

it('accepts a pinned local configuration only after core, code, and contract references match the RPC', async () => {
  const addr = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
  const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
  const addresses = { pool: addr('1'), verifier: addr('2'), adapter: addr('3'), dUSD: addr('4'),
    router02: addr('5'), factory: addr('6'), weth9: addr('7'), pair: addr('8') };
  let adapterRuntime = adapterArtifact.runtimeBytecode.slice(2);
  const immutableIds = { pool: '2636', router02: '2638', factory: '2640', weth: '2642', dUSD: '2644', pair: '2646' };
  const refs = { pool: addresses.pool, router02: addresses.router02, factory: addresses.factory,
    weth: addresses.weth9, dUSD: addresses.dUSD, pair: addresses.pair };
  for (const [name, id] of Object.entries(immutableIds)) {
    const word = refs[name as keyof typeof refs].slice(2).padStart(64, '0');
    for (const { start } of adapterArtifact.immutableReferences[id as keyof typeof adapterArtifact.immutableReferences]) {
      adapterRuntime = `${adapterRuntime.slice(0, start * 2)}${word}${adapterRuntime.slice(start * 2 + 64)}`;
    }
  }
  const codes = { pool: '0x6000', verifier: '0x6001', adapter: `0x${adapterRuntime}`, dUSD: '0x6003',
    // Router02 has constructor-patched immutable addresses in its deployed runtime.
    router02: '0x6002',
    factory: uniswapV2.artifacts.factory.runtimeBytecode,
    weth9: uniswapV2.artifacts.weth9.runtimeBytecode,
    pair: uniswapV2.artifacts.pair.runtimeBytecode };
  const records = Object.fromEntries(Object.entries(addresses).map(([name, address]) => [name, {
    address, runtimeSha256: sha256(toBytes(codes[name as keyof typeof codes])).slice(2),
    txHash: hash('a'), blockNumber: '1', blockHash: hash('b'),
  }])) as unknown as Record<keyof typeof addresses, Record<string, unknown>>;
  const connectionManifest = { schemaVersion: 1, chainId: 31337, generation: 'local-v1',
    contracts: { ...records, adapter: { ...records.adapter, pool: addresses.pool, router02: addresses.router02,
      factory: addresses.factory, weth: addresses.weth9, dUSD: addresses.dUSD, pair: addresses.pair } },
    references: { corePoolAddress: `0x${'99'.repeat(20)}`, poolManifest: { path: 'core.json', sha256: 'a'.repeat(64) } },
    site: { deploymentId: 'local-v1', origin, siweUri: `${origin}/app` },
    provenance: { uniswapSourceLockSha256: uniswapV2.provenance.sourceLockSha256,
      uniswapArtifactPairHash: uniswapV2.pairInitCodeHash },
    assets: { dUSD: { decimals: 18, totalSupply: '1000000000000000000000000' },
      checkpoint: { blockNumber: '2', blockHash: hash('c'), reserve0: '100', reserve1: '200' } },
  };
  const coreManifest = { schemaVersion: 1, chainId: 31337, pool: { address: addresses.pool } };
  const config = { schemaVersion: 1, deploymentId: 'local-v1', coreManifest, connectionManifest,
    serviceCatalogue: { 'local-v1': { origin, siweUri: `${origin}/app`, chainId: 31337,
      pool: addresses.pool, finalityMode: 'local-simulated' } },
    rpcUrl: 'http://127.0.0.1:8545', finalityMode: 'local-simulated' };
  const raw = JSON.stringify(config);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  const expectedSha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const response = new Response(raw, { headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: configUrl });
  vi.stubGlobal('location', { origin, href: `${origin}/app` });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const getCode = vi.fn(async ({ address }: { address: string }) => {
    const name = Object.keys(addresses).find(key => addresses[key as keyof typeof addresses] === address);
    return name ? codes[name as keyof typeof codes] : undefined;
  });
  const readContract = vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
    if (address === addresses.adapter) return addresses[functionName as keyof typeof addresses]
      ?? (functionName === 'weth' ? addresses.weth9 : undefined);
    if (address === addresses.router02) return functionName === 'factory' ? addresses.factory : addresses.weth9;
    if (address === addresses.factory) return addresses.pair;
    if (address === addresses.dUSD) return functionName === 'decimals' ? 18 : 1_000_000n * 10n ** 18n;
    if (address === addresses.pair) return functionName === 'token0' ? addresses.dUSD
      : functionName === 'token1' ? addresses.weth9 : [100n, 200n, 0];
    throw new Error('unexpected read');
  });
  ethereum.createEthereumRpc.mockReturnValue({ mode: 'local-simulated', client: {
    getChainId: async () => 31337, getCode,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber,
      hash: blockNumber === 2n ? hash('c') : hash('b') }), readContract,
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n,
      blockHash: hash('b'), contractAddress: addresses.adapter }),
  } });
  ethereum.verifyEthereumDeployment.mockResolvedValue({ context: { chainId: 31337n,
    pool: addresses.pool, finalityMode: 'local-simulated' }, manifest: coreManifest });

  const loaded = await loadBrowserLiveConfig({ url: configUrl, expectedSha256 });
  expect(loaded.browser.adapter).toBe(addresses.adapter);
  expect(loaded.deployment.token).toBe(addresses.dUSD);
  expect(loaded.verified.manifest).toBe(coreManifest);
  expect(ethereum.verifyEthereumDeployment).toHaveBeenCalledOnce();
  expect(getCode).toHaveBeenCalledWith(expect.objectContaining({ address: addresses.adapter }));

  // A fresh pin to arbitrary code is insufficient to identify the published Adapter artifact.
  codes.adapter = '0x6002';
  (connectionManifest.contracts.adapter as Record<string, unknown>).runtimeSha256 = sha256(toBytes(codes.adapter)).slice(2);
  const changed = JSON.stringify(config);
  const changedDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(changed)));
  const changedPin = [...changedDigest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  vi.stubGlobal('fetch', vi.fn(async () => {
    const reply = new Response(changed);
    Object.defineProperty(reply, 'url', { value: configUrl });
    return reply;
  }));
  await expect(loadBrowserLiveConfig({ url: configUrl, expectedSha256: changedPin }))
    .rejects.toThrow('INVALID_LIVE_CONFIG');
  vi.unstubAllGlobals();
});
