import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAtBlockHash, preflightSepolia, runSepolia } from '../../../scripts/core-sepolia.mjs';

const hash = `0x${'ab'.repeat(32)}`;
const block = { number: 42n, hash };
const manifest = { chainId: 11155111, pool: { address: `0x${'12'.repeat(20)}` } };
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
