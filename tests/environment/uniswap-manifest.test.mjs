import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createUniswapManifest, verifyUniswapManifest } from '../../scripts/uniswap-manifest.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const code = '0x6001600055';
const runtimeSha256 = createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
const contract = n => ({ address: addr(n), runtimeSha256, txHash: hash(n), blockNumber: '7', blockHash: hash(7) });
const contracts = { dUSD: contract(1), router02: contract(2), factory: contract(3), weth9: contract(4), pair: contract(5) };
const assets = {
  dUSD: { decimals: 18, totalSupply: '1000000000000000000000000', initialHolder: addr(10), remainingHolder: addr(10) },
  liquidity: { lpRecipient: addr(11), initialWethWei: '100000000000000000', initialDusdUnits: '10000000000000000000000' },
  checkpoint: { blockNumber: '8', blockHash: hash(8), reserve0: '10000000000000000000000', reserve1: '100000000000000000' },
};
const input = () => ({ chainId: 31337, generation: 'local-001', contracts: structuredClone(contracts), assets: structuredClone(assets),
  site: null, provenance: { sourceCommit: 'a'.repeat(40) }, references: {} });
const client = () => ({
  getChainId: async () => 31337,
  getCode: async () => code,
  getBlock: async ({ blockNumber }) => ({ hash: hash(Number(blockNumber)) }),
  readContract: async ({ address, functionName }) => {
    if (address === contracts.router02.address && functionName === 'factory') return contracts.factory.address;
    if (address === contracts.router02.address && functionName === 'WETH') return contracts.weth9.address;
    if (address === contracts.factory.address && functionName === 'getPair') return contracts.pair.address;
    if (address === contracts.dUSD.address && functionName === 'decimals') return 18;
    if (address === contracts.dUSD.address && functionName === 'totalSupply') return 1000000000000000000000000n;
    if (address === contracts.pair.address && functionName === 'token0') return contracts.dUSD.address;
    if (address === contracts.pair.address && functionName === 'token1') return contracts.weth9.address;
    if (address === contracts.pair.address && functionName === 'getReserves') return [10000000000000000000000n, 100000000000000000n, 0];
    throw new Error(`unexpected read ${functionName}`);
  },
});

test('saved manifest verifies actual code, contract references and the reserve checkpoint', async () => {
  await verifyUniswapManifest(createUniswapManifest(input()), client());
});

test('wrong chain, deployed code and block hash stop verification', async () => {
  const manifest = createUniswapManifest(input());
  await assert.rejects(verifyUniswapManifest(manifest, { ...client(), getChainId: async () => 11155111 }), /chain/i);
  await assert.rejects(verifyUniswapManifest(manifest, { ...client(), getCode: async () => '0x6002' }), /runtime/i);
  await assert.rejects(verifyUniswapManifest(manifest, { ...client(), getBlock: async () => ({ hash: hash(9) }) }), /block hash/i);
});

test('wrong Router or Factory references and changed reserves stop verification', async () => {
  const manifest = createUniswapManifest(input());
  const base = client();
  await assert.rejects(verifyUniswapManifest(manifest, { ...base, readContract: async args =>
    args.functionName === 'factory' ? addr(99) : base.readContract(args) }), /factory/i);
  await assert.rejects(verifyUniswapManifest(manifest, { ...base, readContract: async args =>
    args.functionName === 'getPair' ? addr(99) : base.readContract(args) }), /pair/i);
  await assert.rejects(verifyUniswapManifest(manifest, { ...base, readContract: async args =>
    args.functionName === 'getReserves' ? [1n, 2n, 0] : base.readContract(args) }), /reserve/i);
});

test('manifest creation rejects secret-bearing properties and authenticated URLs', () => {
  const secret = input();
  secret.secretKey = 'hidden';
  assert.throws(() => createUniswapManifest(secret), /secret/i);
  const authenticated = input();
  authenticated.site = { origin: 'https://user:pass@example.test/?api_key=hidden' };
  assert.throws(() => createUniswapManifest(authenticated), /secret|credential/i);
});
