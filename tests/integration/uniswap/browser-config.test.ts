import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';
import { deployPool } from '../../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../../scripts/uniswap-local.mjs';
import { deployConnection } from '../../../scripts/uniswap-integration.mjs';
import { createLiveConfig } from '../../../scripts/uniswap-live-config.mjs';
import { loadBrowserLiveConfig } from '../../../apps/uniswap-web/src/live/browser-config.js';

const holderKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const holder = privateKeyToAccount(holderKey);

async function withAnvil(run: (url: string) => Promise<void>): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing port'));
      server.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--port', String(port),
    '--chain-id', '31337', '--hardfork', 'cancun', '--gas-limit', '30000000'], { stdio: 'ignore' });
  try {
    const rpc = createPublicClient({ transport: http(url) });
    let ready = false;
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try { ready = await rpc.getChainId() === 31337; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Anvil startup timed out');
    await run(url);
  } finally { child.kill('SIGTERM'); }
}

it('loads a pinned browser config against deployed Anvil Pool, Adapter and Uniswap contracts', async () => {
  await withAnvil(async url => {
    const root = mkdtempSync(join(tmpdir(), 'ecu-browser-config-'));
    try {
      const publicClient = createPublicClient({ transport: http(url) });
      const assets = await deployLocalAssets({ url, chainId: 31337, generation: 'browser-config-test',
        holder: holder.address, lpRecipient: holder.address });
      const corePool = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: holderKey, hardfork: 'cancun', onDeployment: undefined });
      const poolManifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: holderKey, hardfork: 'cancun', onDeployment: undefined });
      expect(corePool.pool.address.toLowerCase()).not.toBe(poolManifest.pool.address.toLowerCase());
      const poolPath = join(root, 'pool.json');
      const coreBytes = Buffer.from(JSON.stringify(poolManifest));
      writeFileSync(poolPath, coreBytes);
      const adapterArtifact = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-payment-v1.json', 'utf8'));
      const connection = await deployConnection({ poolManifest, poolManifestPath: poolPath,
        adapterArtifact, assetManifest: assets, signer: holder, publicClient,
        excludedPoolAddress: corePool.pool.address });
      const siteOrigin = 'https://local.invalid';
      const configUrl = `${siteOrigin}/live-config.json`;
      const generated = createLiveConfig({ coreBytes, connectionManifest: connection,
        deploymentId: 'browser-config-test', siteOrigin, siweUri: `${siteOrigin}/app`, rpcUrl: url });
      const actualFetch = globalThis.fetch;
      vi.stubGlobal('location', { origin: siteOrigin, href: `${siteOrigin}/app` });
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === configUrl) {
          const response = new Response(generated.bytes, { headers: { 'content-type': 'application/json' } });
          Object.defineProperty(response, 'url', { value: configUrl });
          return response;
        }
        return actualFetch(input, init);
      });
      try {
        const loaded = await loadBrowserLiveConfig({ url: configUrl, expectedSha256: generated.sha256 });
        expect(loaded.browser.deploymentId).toBe('browser-config-test');
        expect(loaded.browser.pool.toLowerCase()).toBe(poolManifest.pool.address.toLowerCase());
        expect(loaded.browser.adapter.toLowerCase()).toBe(connection.contracts.adapter.address.toLowerCase());
        expect(loaded.deployment.router.toLowerCase()).toBe(assets.contracts.router02.address.toLowerCase());
        expect(loaded.verified.context.pool.toLowerCase()).toBe(poolManifest.pool.address.toLowerCase());
      } finally { vi.unstubAllGlobals(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}, 120_000);
