import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAtBlockHash, finalizeFailedSepolia, parseSepoliaOptions, preflightSepolia,
  runSepolia } from '../../../scripts/core-sepolia.mjs';

const hash = `0x${'ab'.repeat(32)}`;
const block = { number: 42n, hash };
const manifest = { chainId: 11155111, pool: { address: `0x${'12'.repeat(20)}` } };

test('Sepolia options support sourced env without echoing RPC or a pnpm separator', () => {
  const env = { SEPOLIA_RPC_URL: 'https://private.example', POOL_MANIFEST_PATH: 'manifest.json',
    ALICE_KEY_PATH: 'a.key', BOB_KEY_PATH: 'b.key', SUBMITTER_KEY_PATH: 's.key',
    ALICE_STORE_PATH: 'a', BOB_STORE_PATH: 'b', SUBMITTER_JOURNAL_PATH: 'j', PUBLIC_RESULT_PATH: 'out' };
  assert.equal(parseSepoliaOptions([], env).rpc, env.SEPOLIA_RPC_URL);
  assert.equal(parseSepoliaOptions(['--', '--rpc', 'https://rpc.example', '--manifest', 'm',
    '--owner-a-key', 'a', '--owner-b-key', 'b', '--submitter-key', 's',
    '--owner-a-store', 'as', '--owner-b-store', 'bs', '--journal', 'j', '--out', 'o']).rpc,
  'https://rpc.example');
});
function fakeClient({ chainId = 11155111, finalized = block, callError } = {}) {
  let sends = 0;
  const client = {
    getChainId: async () => chainId,
    getBlock: async () => finalized,
    request: async ({ method, params }) => {
      if (method === 'eth_sendRawTransaction') sends++;
      if (method === 'eth_call' && callError) throw callError;
      return '0x';
    },
  };
  return { client, get sends() { return sends; } };
}

test('Sepolia preflight rejects missing RPC and HTTP without sending', async () => {
  const fake = fakeClient();
  for (const rpc of [undefined, 'http://example.invalid']) {
    await assert.rejects(preflightSepolia({ rpc, manifest, client: fake.client,
      verify: async () => ({ context: { pool: manifest.pool.address } }) }));
  }
  assert.equal(fake.sends, 0);
});

test('Sepolia preflight rejects chain, manifest, finality and deployment capability failures', async () => {
  for (const scenario of [
    { chainId: 31337 },
    { manifest: { ...manifest, chainId: 1 } },
    { finalized: null },
    { verify: async () => { throw Error('deployment.logs'); } },
    { verify: async () => { throw Error('deployment.transactionInput'); } },
    { verify: async () => { throw Error('deployment.pinnedState'); } },
  ]) {
    const fake = fakeClient(scenario);
    await assert.rejects(preflightSepolia({ rpc: 'https://rpc.example',
      manifest: scenario.manifest ?? manifest, client: fake.client,
      verify: scenario.verify ?? (async () => ({ context: { pool: manifest.pool.address } })) }));
    assert.equal(fake.sends, 0);
  }
});

test('Sepolia preflight requires a finalized Cancun-or-later block field basis', async () => {
  const fake = fakeClient({ finalized: { ...block, blobGasUsed: 0n, excessBlobGas: 0n } });
  const result = await preflightSepolia({ rpc: 'https://rpc.example', manifest, client: fake.client,
    verify: async () => ({ context: { pool: manifest.pool.address } }) });
  assert.equal(result.point.hash, hash);
  const missing = fakeClient();
  await assert.rejects(preflightSepolia({ rpc: 'https://rpc.example', manifest, client: missing.client,
    verify: async () => ({ context: { pool: manifest.pool.address } }) }), /FORK_UNVERIFIED/);
});

test('pinned rejection extracts only revert selector and checks canonical hash twice', async () => {
  let reads = 0;
  const client = {
    getBlock: async () => { reads++; return block; },
    request: async ({ params }) => {
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true });
      throw { data: '0x12345678' };
    },
  };
  const result = await callAtBlockHash(client, { to: manifest.pool.address, data: '0x12345678',
    account: manifest.pool.address, value: 0n }, hash, block.number);
  assert.equal(result.selector, '0x12345678');
  assert.equal(reads, 2);
});

test('pinned call treats provider errors and changed hashes as unavailable', async () => {
  const client = { getBlock: async () => block, request: async () => { throw Error('network down'); } };
  await assert.rejects(callAtBlockHash(client, { to: manifest.pool.address, data: '0x',
    account: manifest.pool.address, value: 0n }, hash, block.number), /RPC/);
  const changed = { ...client, getBlock: async () => ({ ...block, hash: `0x${'cd'.repeat(32)}` }) };
  await assert.rejects(callAtBlockHash(changed, { to: manifest.pool.address, data: '0x',
    account: manifest.pool.address, value: 0n }, hash, block.number), /CHECKPOINT/);
  let reads = 0;
  const reorg = { getBlock: async () => (++reads === 1 ? block :
    { ...block, hash: `0x${'cd'.repeat(32)}` }), request: async () => { throw { data: '0x12345678' }; } };
  await assert.rejects(callAtBlockHash(reorg, { to: manifest.pool.address, data: '0x',
    account: manifest.pool.address, value: 0n }, hash, block.number), /CHECKPOINT/);
});

test('Sepolia runner refuses an existing public result before connecting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-sepolia-test-'));
  try {
    const out = join(dir, 'result.json');
    const path = join(dir, 'manifest.json');
    await writeFile(out, 'sentinel');
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(runSepolia({ rpc: 'https://invalid.example', manifest: path, out }), /RESULT_EXISTS/);
    assert.equal(await readFile(out, 'utf8'), 'sentinel');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed Sepolia run promotes pending public evidence without erasing a sent tx hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-sepolia-pending-'));
  try {
    const out = join(dir, 'result.json');
    const row = { schemaVersion: 1, caseId: 'S-01-sepolia-deposit', operationOutcome: 'unconfirmed',
      testOutcome: 'not-run', commit: 'a'.repeat(40), artifactHashes: { pool: 'b'.repeat(64) },
      environment: { os: 'darwin', arch: 'arm64', node: '24.21.0', pnpm: '10.34.5', foundry: '1.8.3' },
      execution: { durationMs: '123', timeoutMs: '900000' },
      evidence: { kind: 'test', source: 'scripts/core-sepolia.mjs', testName: 'S-01-sepolia-deposit',
        operationId: `0x${'11'.repeat(32)}`, txHash: `0x${'22'.repeat(32)}`, status: 'pending' } };
    await writeFile(`${out}.pending.json`, JSON.stringify([row]));
    assert.equal(await finalizeFailedSepolia({ out }, 'SEPOLIA_FINALITY_TIMEOUT'), true);
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved[0].evidence.txHash, row.evidence.txHash);
    assert.equal(saved[0].execution.failureReason, 'SEPOLIA_FINALITY_TIMEOUT');
    assert.equal(saved[0].testOutcome, 'not-run');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed preflight records every Sepolia case as not-run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-sepolia-preflight-'));
  try {
    const out = join(dir, 'result.json');
    assert.equal(await finalizeFailedSepolia({ out }, 'SEPOLIA_RPC_CHAIN', Date.now() - 5), true);
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved.length, 9);
    assert.ok(saved.every(row => row.testOutcome === 'not-run' &&
      row.execution.failureReason === 'SEPOLIA_RPC_CHAIN'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
