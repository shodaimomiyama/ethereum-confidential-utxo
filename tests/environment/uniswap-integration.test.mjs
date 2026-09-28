import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeDeployData } from 'viem';
import { withAnvil } from '../../scripts/verifier-deployment.mjs';
import { deployPool } from '../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../scripts/uniswap-local.mjs';
import { deployConnection, verifyConnection, verifyPublicDusd } from '../../scripts/uniswap-integration.mjs';

const testPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const same = (left, right) => left.toLowerCase() === right.toLowerCase();

test('connection requires pinned Sepolia records and a separate core Pool', async () => {
  const publicClient = { getChainId: async () => 11155111, transport: { url: 'http://127.0.0.1:1' } };
  const input = { poolManifest: { chainId: 11155111, pool: { address: '0x1111111111111111111111111111111111111111' } },
    poolManifestPath: '/missing-pool-manifest.json', adapterArtifact: {}, assetManifest: { chainId: 11155111 },
    signer: { address: '0x2222222222222222222222222222222222222222' }, publicClient,
    excludedPoolAddress: '0x3333333333333333333333333333333333333333' };
  await assert.rejects(deployConnection(input), /public chain.*not supported/i);
  await assert.rejects(verifyConnection({ chainId: 11155111 }, {
    ...publicClient,
    getBlock: async ({ blockTag }) => {
      assert.equal(blockTag, 'finalized');
      return { number: 12n, hash: `0x${'12'.repeat(32)}` };
    },
  }), /Pool manifest reference invalid/i);
  await assert.rejects(deployConnection({ ...input, poolManifest: { ...input.poolManifest, chainId: 31337 },
    assetManifest: { chainId: 31337 }, publicClient: { ...publicClient, getChainId: async () => 31337 },
    excludedPoolAddress: undefined }), /core Pool address required/i);
});

test('connection refuses Sepolia verification without a finalized checkpoint', async () => {
  const publicClient = { getChainId: async () => 11155111,
    getBlock: async () => ({ number: 12n, hash: null }),
    transport: { url: 'http://127.0.0.1:1' } };
  await assert.rejects(verifyConnection({ chainId: 11155111 }, publicClient), /finalized checkpoint/i);
});

test('public dUSD must have the pinned constructor transaction before the finalized checkpoint', async () => {
  const manifest = { contracts: { dUSD: { address: '0x1111111111111111111111111111111111111111',
    txHash: `0x${'22'.repeat(32)}`, blockNumber: '5', blockHash: `0x${'33'.repeat(32)}` } },
    assets: { dUSD: { initialHolder: '0x4444444444444444444444444444444444444444' } } };
  const rpc = { getTransaction: async () => ({ to: null, input: '0x00' }),
    getTransactionReceipt: async () => ({ status: 'success',
      contractAddress: manifest.contracts.dUSD.address, blockNumber: 5n,
      blockHash: manifest.contracts.dUSD.blockHash }) };
  await assert.rejects(verifyPublicDusd(manifest, rpc, { number: 9n }), /dUSD deployment transaction mismatch/i);
  const artifact = JSON.parse(readFileSync('contracts/out/DemoUSD.sol/DemoUSD.json', 'utf8'));
  const expected = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    args: [manifest.assets.dUSD.initialHolder] });
  await verifyPublicDusd(manifest, { ...rpc, getTransaction: async () => ({ to: null, input: expected }) },
    { number: 9n });
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
