import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { createPublicClient, createWalletClient, http } from 'viem';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAnvil } from '../../scripts/verifier-deployment.mjs';
import {
  beginLocalDeployment, captureLocalSnapshot, completeLocalDeployment, deployLocalAssets,
  restoreLocalSnapshot, verifyLocalAssets,
} from '../../scripts/uniswap-local.mjs';

const execFileAsync = promisify(execFile);

test('an interrupted deployment keeps an attempt record and cannot silently restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'uniswap-local-attempt-'));
  const path = join(root, 'manifest.json');
  try {
    beginLocalDeployment(path, { chainId: 31337, generation: 'test', holder: '0x1111111111111111111111111111111111111111' });
    assert.equal(existsSync(`${path}.attempt.json`), true);
    assert.throws(() => beginLocalDeployment(path, { chainId: 31337, generation: 'test' }), /attempt|pending/i);
    completeLocalDeployment(path, { chainId: 31337, generation: 'test' });
    assert.equal(existsSync(`${path}.attempt.json`), false);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).generation, 'test');
    assert.throws(() => beginLocalDeployment(path, { chainId: 31337, generation: 'test' }), /manifest|exists/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI rejects invalid holder and wrong RPC chain before recording an attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uniswap-local-preflight-'));
  const path = join(root, 'manifest.json');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xaa36a7' }));
  });
  try {
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const args = ['scripts/uniswap-local.mjs', 'deploy', '--rpc-url', url, '--chain-id', '31337',
      '--manifest', path, '--generation', 'preflight', '--holder', 'invalid',
      '--lp-recipient', '0x1111111111111111111111111111111111111111'];
    await assert.rejects(execFileAsync(process.execPath, args), /holder and LP recipient addresses required/);
    assert.equal(existsSync(`${path}.attempt.json`), false);
    args[args.indexOf('invalid')] = '0x1111111111111111111111111111111111111111';
    await assert.rejects(execFileAsync(process.execPath, args), /RPC chain ID mismatch/);
    assert.equal(existsSync(`${path}.attempt.json`), false);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('local assets deploy with 0.1 WETH and 10000 dUSD, then verify without adding liquidity twice', async () => {
  await withAnvil(async ({ url, rpc }) => {
    const [holder, lpRecipient] = await rpc('eth_accounts', []);
    const input = { url, chainId: 31337, generation: 'local-assets-test', holder, lpRecipient };
    const manifest = await deployLocalAssets(input);
    const client = createPublicClient({ transport: http(url) });
    const bundle = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-v2.json', 'utf8'));
    const dusd = JSON.parse(readFileSync('contracts/out/DemoUSD.sol/DemoUSD.json', 'utf8'));
    assert.equal(manifest.assets.dUSD.totalSupply, '1000000000000000000000000');
    assert.equal(manifest.assets.liquidity.initialWethWei, '100000000000000000');
    assert.equal(manifest.assets.liquidity.initialDusdUnits, '10000000000000000000000');
    await verifyLocalAssets(manifest, client);
    const wrongSource = structuredClone(manifest);
    wrongSource.provenance.uniswapSourceLockSha256 = '0'.repeat(64);
    await assert.rejects(verifyLocalAssets(wrongSource, client), /source|provenance/i);
    const wrongDeployment = structuredClone(manifest);
    wrongDeployment.contracts.factory.txHash = `0x${'12'.repeat(32)}`;
    await assert.rejects(verifyLocalAssets(wrongDeployment, client), /transaction|receipt|deployment/i);
    const wrongHolder = structuredClone(manifest);
    wrongHolder.assets.dUSD.remainingHolder = manifest.contracts.factory.address;
    await assert.rejects(verifyLocalAssets(wrongHolder, client), /holder|balance/i);
    const wrongLpRecipient = structuredClone(manifest);
    wrongLpRecipient.assets.liquidity.lpRecipient = manifest.contracts.factory.address;
    await assert.rejects(verifyLocalAssets(wrongLpRecipient, client), /LP|liquidity|balance/i);
    const before = await client.readContract({ address: manifest.contracts.pair.address,
      abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'totalSupply' });
    const again = await deployLocalAssets({ ...input, existingManifest: manifest });
    assert.deepEqual(again, manifest);
    const after = await client.readContract({ address: manifest.contracts.pair.address,
      abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'totalSupply' });
    assert.equal(after, before);
    const holderBalanceBefore = await client.readContract({ address: manifest.contracts.dUSD.address,
      abi: dusd.abi, functionName: 'balanceOf', args: [holder] });
    assert.equal(holderBalanceBefore, 990000000000000000000000n);
    const lpBalance = await client.readContract({ address: manifest.contracts.pair.address,
      abi: bundle.artifacts.pair.abi, functionName: 'balanceOf', args: [lpRecipient] });
    assert.ok(lpBalance > 0n);
    const wallet = createWalletClient({ account: holder, transport: http(url) });
    const snapshot = await captureLocalSnapshot({ publicClient: client, manifest });
    await assert.rejects(restoreLocalSnapshot(snapshot, { publicClient: client, manifest,
      serviceState: { status: 'active', pendingReservations: 1 } }), /service|reservation/i);
    await assert.rejects(restoreLocalSnapshot(snapshot, { publicClient: { getChainId: async () => 11155111 },
      manifest }), /chain/i);
    const latest = await client.getBlock();
    const swapArgs = [1n, [manifest.contracts.weth9.address, manifest.contracts.dUSD.address], holder,
      latest.timestamp + 300n];
    await client.simulateContract({ address: manifest.contracts.router02.address,
      abi: bundle.artifacts.router02.abi, functionName: 'swapExactETHForTokens', args: swapArgs,
      account: holder, value: 1000000000000000n });
    const swapHash = await wallet.writeContract({ address: manifest.contracts.router02.address,
      abi: bundle.artifacts.router02.abi, functionName: 'swapExactETHForTokens',
      args: swapArgs, value: 1000000000000000n, gas: 250000n, chain: null });
    const swap = await client.waitForTransactionReceipt({ hash: swapHash });
    const swapTx = await client.getTransaction({ hash: swapHash });
    assert.equal(swap.status, 'success', `swap gas used ${swap.gasUsed}, limit ${swapTx.gas}`);
    const holderBalanceAfter = await client.readContract({ address: manifest.contracts.dUSD.address,
      abi: dusd.abi, functionName: 'balanceOf', args: [holder] });
    assert.ok(holderBalanceAfter > holderBalanceBefore);
    await verifyLocalAssets(manifest, client);
    const nextSnapshot = await restoreLocalSnapshot(snapshot, { publicClient: client, manifest });
    assert.notEqual(nextSnapshot.snapshotId, snapshot.snapshotId);
    const restored = await client.readContract({ address: manifest.contracts.pair.address,
      abi: bundle.artifacts.pair.abi, functionName: 'getReserves' });
    assert.equal(String(restored[0]), manifest.assets.checkpoint.reserve0);
    assert.equal(String(restored[1]), manifest.assets.checkpoint.reserve1);
    await assert.rejects(deployLocalAssets({ ...input, chainId: 11155111 }), /chain/i);
    const corrupted = structuredClone(manifest);
    corrupted.contracts.pair.runtimeSha256 = '0'.repeat(64);
    await assert.rejects(deployLocalAssets({ ...input, existingManifest: corrupted }), /runtime/i);
  });
});
