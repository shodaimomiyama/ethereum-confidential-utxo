import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { withAnvil } from '../../scripts/verifier-deployment.mjs';
import { deployPool } from '../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../scripts/uniswap-local.mjs';
import { deployConnection, verifyConnection } from '../../scripts/uniswap-integration.mjs';

const testPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const same = (left, right) => left.toLowerCase() === right.toLowerCase();

test('connection refuses public chains without pinned asset verification and requires a separate core Pool', async () => {
  const publicClient = { getChainId: async () => 11155111, transport: { url: 'http://127.0.0.1:1' } };
  const input = { poolManifest: { chainId: 11155111, pool: { address: '0x1111111111111111111111111111111111111111' } },
    poolManifestPath: '/missing-pool-manifest.json', adapterArtifact: {}, assetManifest: { chainId: 11155111 },
    signer: { address: '0x2222222222222222222222222222222222222222' }, publicClient,
    excludedPoolAddress: '0x3333333333333333333333333333333333333333' };
  await assert.rejects(deployConnection(input), /public chain.*not supported/i);
  await assert.rejects(verifyConnection({ chainId: 11155111 }, publicClient), /public chain.*not supported/i);
  await assert.rejects(deployConnection({ ...input, poolManifest: { ...input.poolManifest, chainId: 31337 },
    assetManifest: { chainId: 31337 }, publicClient: { ...publicClient, getChainId: async () => 31337 },
    excludedPoolAddress: undefined }), /core Pool address required/i);
});

test('formal Pool and Adapter deployment is independently reproducible from saved manifests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uniswap-connection-'));
  try {
    await withAnvil(async ({ url, rpc, client }) => {
      const [holder] = await rpc('eth_accounts', []);
      const assetManifest = await deployLocalAssets({ url, chainId: 31337, generation: 'connection-test',
        holder, lpRecipient: holder });
      const corePool = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: testPrivateKey, hardfork: 'cancun' });
      const poolManifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: testPrivateKey, hardfork: 'cancun' });
      assert.ok(!same(corePool.pool.address, poolManifest.pool.address));
      const poolManifestPath = join(root, 'pool.json');
      writeFileSync(poolManifestPath, JSON.stringify(poolManifest));
      const adapterArtifact = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-payment-v1.json', 'utf8'));
      const manifest = await deployConnection({ poolManifest, poolManifestPath, adapterArtifact,
        assetManifest, signer: privateKeyToAccount(testPrivateKey), publicClient: client,
        excludedPoolAddress: corePool.pool.address });
      assert.ok(same(manifest.contracts.pool.address, poolManifest.pool.address));
      assert.ok(same(manifest.contracts.verifier.address, poolManifest.verifier.address));
      assert.ok(same(manifest.contracts.adapter.pool, poolManifest.pool.address));
      assert.ok(same(manifest.contracts.adapter.weth, assetManifest.contracts.weth9.address));
      assert.equal(manifest.references.poolManifest.path, poolManifestPath);
      assert.equal(manifest.references.poolManifest.sha256.length, 64);
      const saved = JSON.parse(JSON.stringify(manifest));
      await verifyConnection(saved, client);
      const wrongChain = structuredClone(saved);
      wrongChain.chainId = 11155111;
      await assert.rejects(verifyConnection(wrongChain, client), /chain/i);
      const wrongPool = structuredClone(saved);
      wrongPool.contracts.adapter.pool = corePool.pool.address;
      await assert.rejects(verifyConnection(wrongPool, client), /reference|pool|immutable/i);
      const wrongCode = structuredClone(saved);
      wrongCode.contracts.adapter.runtimeSha256 = '0'.repeat(64);
      await assert.rejects(verifyConnection(wrongCode, client), /runtime/i);
      const wrongHash = structuredClone(saved);
      wrongHash.references.poolManifest.sha256 = '0'.repeat(64);
      await assert.rejects(verifyConnection(wrongHash, client), /Pool manifest|hash/i);
      writeFileSync(poolManifestPath, JSON.stringify({ ...poolManifest, chainId: 11155111 }));
      await assert.rejects(verifyConnection(saved, client), /Pool manifest|hash/i);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
