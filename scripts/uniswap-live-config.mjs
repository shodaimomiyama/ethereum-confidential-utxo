import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const address = /^0x[0-9a-fA-F]{40}$/;
const digest = /^[0-9a-fA-F]{64}$/;
const names = ['pool', 'verifier', 'adapter', 'dUSD', 'router02', 'factory', 'weth9', 'pair'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.toLowerCase() === b.toLowerCase();

function rejectSecrets(value, key = '') {
  if (/secret|private.?key|password|api.?key|authorization|bearer|rpc.?url/i.test(key)) {
    throw new Error(`secret field forbidden: ${key}`);
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || [...url.searchParams.keys()].some(item =>
      /key|secret|token|auth|password|credential/i.test(item))) {
      throw new Error('secret URL forbidden');
    }
  } else if (Array.isArray(value)) {
    value.forEach(item => rejectSecrets(item, key));
  } else if (value && typeof value === 'object') {
    for (const [child, item] of Object.entries(value)) rejectSecrets(item, child);
  }
}

function exactOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('HTTPS service origin required'); }
  if (url.protocol !== 'https:' || url.origin !== input || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new Error('HTTPS service origin required');
  return input;
}

function localRpc(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('loopback RPC URL required'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('loopback RPC URL required');
  return input;
}

export function createLiveConfig({ coreBytes, connectionManifest, deploymentId, siteOrigin,
  siweUri, rpcUrl }) {
  if (!Buffer.isBuffer(coreBytes) && !(coreBytes instanceof Uint8Array)) {
    throw new Error('core manifest bytes required');
  }
  let coreManifest;
  try { coreManifest = JSON.parse(Buffer.from(coreBytes).toString('utf8')); }
  catch { throw new Error('invalid core manifest JSON'); }
  const connection = structuredClone(connectionManifest);
  const records = connection?.contracts;
  if (coreManifest?.chainId !== 31337 || connection?.schemaVersion !== 1
    || connection.chainId !== 31337 || !records
    || names.some(name => !address.test(records[name]?.address ?? '')
      || !digest.test(records[name]?.runtimeSha256 ?? ''))) {
    throw new Error('complete connection manifest on local chain required');
  }
  const coreHash = sha256(coreBytes);
  if (!same(connection.references?.poolManifest?.sha256, coreHash)) {
    throw new Error('core manifest hash reference mismatch');
  }
  if (!same(coreManifest.pool?.address, records.pool.address)
    || !same(coreManifest.verifier?.address, records.verifier.address)
    || !address.test(connection.references?.corePoolAddress ?? '')
    || same(connection.references.corePoolAddress, records.pool.address)
    || !same(records.adapter.pool, records.pool.address)) {
    throw new Error('core and connection contract mismatch');
  }
  const expected = { router02: records.router02.address, factory: records.factory.address,
    weth: records.weth9.address, dUSD: records.dUSD.address, pair: records.pair.address };
  for (const [key, value] of Object.entries(expected)) {
    if (!same(records.adapter[key], value)) throw new Error(`adapter ${key} reference mismatch`);
  }
  if (typeof deploymentId !== 'string' || !/^[\x21-\x7e]+$/.test(deploymentId)
    || typeof connection.generation !== 'string' || !connection.generation) {
    throw new Error('deployment ID and generation required');
  }
  const origin = exactOrigin(siteOrigin);
  let uri;
  try { uri = new URL(siweUri); } catch { throw new Error('same-origin HTTPS SIWE URI required'); }
  if (uri.protocol !== 'https:' || uri.origin !== origin || uri.href !== siweUri
    || uri.username || uri.password || uri.search || uri.hash) {
    throw new Error('same-origin HTTPS SIWE URI required');
  }
  if (connection.site !== null && connection.site !== undefined
    && (connection.site.deploymentId !== deploymentId || connection.site.origin !== origin
      || connection.site.siweUri !== siweUri)) {
    throw new Error('existing connection site differs');
  }
  connection.site = { deploymentId, origin, siweUri };
  rejectSecrets(connection);
  rejectSecrets(coreManifest);
  const config = { schemaVersion: 1, deploymentId, coreManifest, connectionManifest: connection,
    serviceCatalogue: { [deploymentId]: { origin, siweUri, chainId: 31337,
      pool: records.pool.address, finalityMode: 'local-simulated' } },
    rpcUrl: localRpc(rpcUrl), finalityMode: 'local-simulated' };
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  if (bytes.length > 1_048_576) throw new Error('live config too large');
  return { bytes, sha256: sha256(bytes) };
}

function parseArgs(args) {
  if (args[0] === '--') args = args.slice(1);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith('--') || !args[i + 1] || key in options) throw new Error('invalid arguments');
    options[key] = args[i + 1];
  }
  const required = ['--core-manifest', '--connection-manifest', '--deployment-id',
    '--site-origin', '--siwe-uri', '--rpc-url', '--output'];
  if (Object.keys(options).length !== required.length || required.some(key => !options[key])) {
    throw new Error(`usage: node scripts/uniswap-live-config.mjs ${required.map(key => `${key} VALUE`).join(' ')}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = createLiveConfig({ coreBytes: readFileSync(options['--core-manifest']),
      connectionManifest: JSON.parse(readFileSync(options['--connection-manifest'], 'utf8')),
      deploymentId: options['--deployment-id'], siteOrigin: options['--site-origin'],
      siweUri: options['--siwe-uri'], rpcUrl: options['--rpc-url'] });
    writeFileSync(options['--output'], result.bytes, { flag: 'wx', mode: 0o644 });
    process.stdout.write(`VITE_DIM_LIVE_CONFIG_SHA256=${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
