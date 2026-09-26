import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withAnvil } from '../../scripts/verifier-deployment.mjs';
import { deployPool, verifyDeployment, loadArtifacts, poolRuntimeFor } from '../../scripts/pool-deployment.mjs';

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('Pool and verifier deploy with a saved, independently rechecked manifest', async () => {
  await withAnvil(async ({ url, rpc, client }) => {
    await assert.rejects(deployPool({ rpcUrl: url, expectedChainId: 11155111,
      privateKey: ANVIL_KEY, hardfork: 'cancun' }), /wrong chain ID/);
    const manifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
      privateKey: ANVIL_KEY, hardfork: 'cancun' });
    const directory = mkdtempSync(join(tmpdir(), 'ecu-pool-manifest-'));
    const path = join(directory, 'pool.json');
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await verifyDeployment(JSON.parse(readFileSync(path, 'utf8')), url);
    assert.equal(result.pool.address.toLowerCase(), manifest.pool.address.toLowerCase());
    const cliPath = join(directory, 'pool-cli.json');
    execFileSync(process.execPath, ['scripts/deploy-pool.mjs', '--rpc', url, '--chain-id', '31337',
      '--hardfork', 'cancun',
      '--out', cliPath], { env: { ...process.env, POOL_DEPLOY_PRIVATE_KEY: ANVIL_KEY } });
    execFileSync(process.execPath, ['scripts/verify-pool-deployment.mjs', '--rpc', url,
      '--manifest', cliPath]);
    assert.ok(JSON.parse(readFileSync(cliPath, 'utf8')).pool.transactionHash);
    rmSync(directory, { recursive: true, force: true });
    const mutations = [
      copy => { copy.chainId = 11155111; },
      copy => { copy.pool.runtimeSha256 = '0'.repeat(64); },
      copy => { copy.pool.constructorArgsSha256 = '0'.repeat(64); },
      copy => { copy.verifier.address = copy.pool.address; },
      copy => { copy.parametersHash = `0x${'00'.repeat(32)}`; },
      copy => { copy.pool.transactionHash = copy.verifier.transactionHash; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(manifest);
      mutate(tampered);
      await assert.rejects(verifyDeployment(tampered, url));
    }
    const slot = `0x${(256n).toString(16).padStart(64, '0')}`;
    const original = await client.getStorageAt({ address: manifest.verifier.address, slot });
    await rpc('anvil_setStorageAt', [manifest.verifier.address, slot, `0x${'00'.repeat(32)}`]);
    await assert.rejects(verifyDeployment(manifest, url), /verifier valueBase mismatch/);
    await rpc('anvil_setStorageAt', [manifest.verifier.address, slot, original]);
    const wrongReferenceRuntime = poolRuntimeFor(loadArtifacts().pool,
      '0x2222222222222222222222222222222222222222');
    await rpc('anvil_setCode', [manifest.pool.address, wrongReferenceRuntime]);
    await assert.rejects(verifyDeployment(manifest, url), /deployed runtime mismatch/);
  });
});
