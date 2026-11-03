import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveConfig } from '../../scripts/uniswap-live-config.mjs';

const addr = digit => `0x${digit.repeat(40)}`;
const record = digit => ({ address: addr(digit), runtimeSha256: digit.repeat(64),
  txHash: `0x${digit.repeat(64)}`, blockNumber: '1', blockHash: `0x${digit.repeat(64)}` });
const core = { schemaVersion: 1, chainId: 31337, pool: { address: addr('1') },
  verifier: { address: addr('2') } };
const coreBytes = Buffer.from(`${JSON.stringify(core)}\n`);
const coreHash = createHash('sha256').update(coreBytes).digest('hex');
const connection = () => ({ schemaVersion: 1, chainId: 31337, generation: 'local-1',
  contracts: { pool: record('1'), verifier: record('2'), adapter: { ...record('3'), pool: addr('1'),
    router02: addr('5'), factory: addr('6'), weth: addr('7'), dUSD: addr('4'), pair: addr('8') },
  dUSD: record('4'), router02: record('5'), factory: record('6'), weth9: record('7'), pair: record('8') },
  references: { corePoolAddress: addr('9'), poolManifest: { path: 'core.json', sha256: coreHash } },
  site: null, assets: {}, provenance: {} });
const options = () => ({ coreBytes, connectionManifest: connection(), deploymentId: 'local-1',
  siteOrigin: 'https://localhost:5173', siweUri: 'https://localhost:5173/app',
  rpcUrl: 'http://127.0.0.1:8545' });

test('creates exact-byte pinned composite config and service catalogue', () => {
  const result = createLiveConfig(options());
  assert.equal(createHash('sha256').update(result.bytes).digest('hex'), result.sha256);
  const parsed = JSON.parse(result.bytes.toString());
  assert.equal(parsed.connectionManifest.site.origin, 'https://localhost:5173');
  assert.equal(parsed.serviceCatalogue['local-1'].siweUri, 'https://localhost:5173/app');
  assert.equal(parsed.coreManifest.pool.address, addr('1'));
  assert.equal(parsed.finalityMode, 'local-simulated');
});

test('rejects asset-only, incorrect core reference, and insecure service origin', () => {
  const input = options();
  delete input.connectionManifest.contracts.adapter;
  assert.throws(() => createLiveConfig(input), /complete connection/i);
  const changed = options();
  changed.connectionManifest.references.poolManifest.sha256 = 'f'.repeat(64);
  assert.throws(() => createLiveConfig(changed), /core manifest hash/i);
  const samePool = options();
  samePool.connectionManifest.references.corePoolAddress = addr('1');
  assert.throws(() => createLiveConfig(samePool), /core and connection contract mismatch/i);
  assert.throws(() => createLiveConfig({ ...options(), siteOrigin: 'http://localhost:5173' }), /HTTPS/i);
  const secret = options();
  secret.connectionManifest.apiKey = 'hidden';
  assert.throws(() => createLiveConfig(secret), /secret field/i);
});

test('CLI writes the public config once and reports its exact byte pin', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ecu-live-config-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const corePath = join(directory, 'core.json');
  const connectionPath = join(directory, 'connection.json');
  const outputPath = join(directory, 'live-config.json');
  writeFileSync(corePath, coreBytes);
  writeFileSync(connectionPath, JSON.stringify(connection()));
  const args = ['scripts/uniswap-live-config.mjs', '--core-manifest', corePath,
    '--connection-manifest', connectionPath, '--deployment-id', 'local-1',
    '--site-origin', 'https://localhost:5173', '--siwe-uri', 'https://localhost:5173/app',
    '--rpc-url', 'http://127.0.0.1:8545', '--output', outputPath];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const actual = sha256(readFileSync(outputPath));
  assert.equal(first.stdout.trim(), `VITE_DIM_LIVE_CONFIG_SHA256=${actual}`);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.equal(sha256(readFileSync(outputPath)), actual);
});

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
