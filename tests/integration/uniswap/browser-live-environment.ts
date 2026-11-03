import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { bytesToHex, createPublicClient, createWalletClient, hexToBytes, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { authorizeOperation, buildOperation, recipientInfoTypedData, synchronize } from '@confidential-utxo/core';
import { createHistoryPort, createOperationSigner, createRecipientInfoSigner,
  defaultRpcPolicy, submitPublicOperation, verifyEthereumDeployment } from '@confidential-utxo/ethereum';
import { createKeySession, recipientMessage } from '../../../apps/uniswap-web/src/live/key-session.js';
import { deployPool } from '../../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../../scripts/uniswap-local.mjs';
import { deployConnection } from '../../../scripts/uniswap-integration.mjs';
import { createLiveConfig } from '../../../scripts/uniswap-live-config.mjs';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const execFileAsync = promisify(execFile);
const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const operatorKey = `0x${'31'.repeat(32)}` as const;
const stateKey = `0x${'33'.repeat(32)}` as const;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('PORT_UNAVAILABLE'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForAnvil(child: ChildProcess, url: string): Promise<void> {
  const rpc = createPublicClient({ transport: http(url) });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('ANVIL_EXITED');
    try { if (await rpc.getChainId() === 31337) return; }
    catch { /* Anvil may not yet be listening. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('ANVIL_TIMEOUT');
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    let forced: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(forced);
      child.removeListener('close', done);
      resolve();
    };
    child.once('close', done);
    child.kill('SIGTERM');
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      forced = setTimeout(done, 2_000);
    }, 2_000);
  });
}

async function buildService(directory: string): Promise<string> {
  const output = join(directory, 'service.mjs');
  await build({ entryPoints: [join(root, 'apps/uniswap-service/src/index.ts')], outfile: output,
    bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
    logLevel: 'silent', plugins: [{ name: 'webcrypto', setup(api) {
      api.onResolve({ filter: /^crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' }));
      api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        contents: 'export const webcrypto = globalThis.crypto;', loader: 'js',
      }));
    } }] });
  return readFile(output, 'utf8');
}

async function buildSite(directory: string, deploymentId: string, digest: string): Promise<string> {
  const output = join(directory, 'site');
  const env = { ...process.env, VITE_DIM_MODE: 'live', VITE_DIM_DEPLOYMENT_ID: deploymentId,
    VITE_DIM_LIVE_CONFIG_URL: '/live-config.json', VITE_DIM_LIVE_CONFIG_SHA256: digest };
  await new Promise<void>((done, reject) => {
    const child = spawn('pnpm', ['--dir', 'apps/uniswap-web', 'exec', 'vite', 'build', '--outDir', output],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`SITE_BUILD_FAILED ${stderr.slice(-4000)}`)));
  });
  return output;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

export interface BrowserLiveEnvironment {
  readonly origin: string;
  readonly appUrl: string;
  readonly deploymentId: string;
  readonly rpcUrl: string;
  readonly browserRpcUrl: string;
  readonly accountPrivateKey: `0x${string}`;
  readonly accountAddress: string;
  readonly operatorPrivateKey: `0x${string}`;
  readonly rewardAvailableWei: bigint;
  readonly coreManifest: unknown;
  readonly connectionManifest: unknown;
  readonly liveConfigSha256: string;
  close(): Promise<void>;
}

/** Starts a disposable, same-origin HTTPS site, real service DO, and local chain. */
export async function startBrowserLiveEnvironment(): Promise<BrowserLiveEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), 'ecu-browser-live-'));
  const deploymentId = 'browser-local-v1';
  const rpcPort = await freePort();
  const httpsPort = await freePort();
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const origin = `https://localhost:${httpsPort}`;
  let anvil: ChildProcess | undefined;
  let miniflare: Miniflare | undefined;
  let server: HttpsServer | undefined;
  const close = async () => {
    let failure: unknown;
    if (server?.listening) {
      try { await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); }
      catch (error) { failure = error; }
    }
    if (miniflare) {
      try { await miniflare.dispose(); }
      catch (error) { failure ??= error; }
    }
    if (anvil) {
      try { await stopAnvil(anvil); }
      catch (error) { failure ??= error; }
    }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
  };
  try {
    anvil = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--port', String(rpcPort),
      '--chain-id', '31337', '--hardfork', 'cancun', '--gas-limit', '30000000'], { stdio: 'ignore' });
    await waitForAnvil(anvil, rpcUrl);
    const rpc = createPublicClient({ transport: http(rpcUrl) });
    const deployer = privateKeyToAccount(deployerKey);
    const assets = await deployLocalAssets({ url: rpcUrl, chainId: 31337, generation: deploymentId,
      holder: deployer.address, lpRecipient: deployer.address });
    const excluded = await deployPool({ rpcUrl, expectedChainId: 31337, privateKey: deployerKey,
      hardfork: 'cancun', onDeployment: undefined });
    const coreManifest = await deployPool({ rpcUrl, expectedChainId: 31337, privateKey: deployerKey,
      hardfork: 'cancun', onDeployment: undefined });
    const coreBytes = Buffer.from(`${JSON.stringify(coreManifest, null, 2)}\n`);
    const corePath = join(directory, 'pool.json');
    await writeFile(corePath, coreBytes);
    const adapterArtifact = JSON.parse(await readFile(join(root,
      'packages/ethereum/generated/uniswap-payment-v1.json'), 'utf8'));
    const connectionManifest = await deployConnection({ poolManifest: coreManifest,
      poolManifestPath: corePath, adapterArtifact, assetManifest: assets, signer: deployer,
      publicClient: rpc, excludedPoolAddress: excluded.pool.address });
    const operator = privateKeyToAccount(operatorKey);
    const operatorGas = await createWalletClient({ account: deployer, chain: foundry,
      transport: http(rpcUrl) }).sendTransaction({ to: operator.address, value: 10n ** 18n });
    await rpc.waitForTransactionReceipt({ hash: operatorGas });
    const verified = await verifyEthereumDeployment(rpc, coreManifest, 'local-simulated');
    const history = createHistoryPort(verified, rpc, defaultRpcPolicy);
    const scope = { deploymentId, owner: operator.address };
    const keys = createKeySession({ subscribe: () => () => {} }, { scope: scope as never, epoch: 1 },
      { chainId: verified.context.chainId, pool: verified.context.pool });
    const keySignature = await operator.signMessage({ message: {
      raw: recipientMessage(verified.context.chainId, verified.context.pool as never, operator.address as never),
    } });
    await keys.prepare(keySignature);
    const serviceReceiptKey = bytesToHex(keys.recipientPrivateKeyForWorker());
    const unsignedRecipient = keys.recipientInfo();
    const recipientSigner = createRecipientInfoSigner(operator, operator.address);
    const recipient = { ...unsignedRecipient, signature: await recipientSigner.signTypedData(
      recipientInfoTypedData(verified.context, unsignedRecipient, operator.address)) };
    const rewardAvailableWei = 12_000_000_000_000_000n;
    const draft = await buildOperation({ kind: 0, owner: operator.address,
      amount: rewardAvailableWei, recipient }, verified.context,
    { inputs: [], randomSalt: () => randomBytes(32) });
    const signature = await authorizeOperation(verified.context, draft.request,
      createOperationSigner(operator, operator.address));
    const wallet = createWalletClient({ account: deployer, chain: foundry,
      transport: http(rpcUrl) }).extend(publicActions);
    const submitted = await submitPublicOperation(verified, history, wallet, deployer.address,
      { request: draft.request, balanceProof: draft.balanceProof,
        rangeProofs: draft.rangeProofs, signature });
    if (!submitted.attempt.txHash ||
      (await rpc.waitForTransactionReceipt({ hash: submitted.attempt.txHash })).status !== 'success') {
      throw new Error('REWARD_FUNDING_FAILED');
    }
    const funded = await synchronize(verified.context, { history,
      keys: { getKey: async () => hexToBytes(serviceReceiptKey) }, owners: [operator.address] });
    if (funded.status !== 'complete' || funded.receiptFailures.length !== 0 ||
      funded.utxos.filter(item => item.status === 'available').reduce((sum, item) => sum + item.opening.amount, 0n)
      !== rewardAvailableWei) throw new Error('REWARD_FUNDING_UNVERIFIED');
    keys.dispose();
    const config = createLiveConfig({ coreBytes, connectionManifest, deploymentId, siteOrigin: origin,
      siweUri: `${origin}/app`, rpcUrl: `${origin}/rpc` });
    const configBytes = config.bytes;
    const site = await buildSite(directory, deploymentId, config.sha256);
    const script = await buildService(directory);
    miniflare = new Miniflare({ script, modules: true, compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { UNISWAP_STATE: { className: 'UniswapServiceObject', useSQLite: true } },
      durableObjectsPersist: join(directory, 'do'), bindings: {
        DEPLOYMENTS_JSON: JSON.stringify({ [deploymentId]: { origin, siweUri: `${origin}/app`,
          chainId: 31337, pool: coreManifest.pool.address, finalityMode: 'local-simulated' } }),
        RECOVERY_JSON: JSON.stringify({ [deploymentId]: { generation: deploymentId,
          stopped: false, initialize: true } }),
        RPC_DEPLOYMENTS_JSON: JSON.stringify({ [deploymentId]: { url: rpcUrl, manifest: coreManifest } }),
        REWARD_SECRETS_JSON: JSON.stringify({ [deploymentId]: { ownerPrivateKey: operatorKey,
          receiptKey: serviceReceiptKey, stateKey } }),
      } });
    await miniflare.ready;
    const namespace = await miniflare.getDurableObjectNamespace('UNISWAP_STATE');
    await (namespace.get(namespace.idFromName(deploymentId)) as unknown as {
      initializeForDeployment(id: string): Promise<void>;
    }).initializeForDeployment(deploymentId);
    const cert = join(directory, 'localhost.crt');
    const key = join(directory, 'localhost.key');
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost']);
    const certBytes = await readFile(cert);
    const keyBytes = await readFile(key);
    const mf = miniflare;
    server = createHttpsServer({ cert: certBytes, key: keyBytes }, async (request, response) => {
      try {
        const path = new URL(request.url ?? '/', origin).pathname;
        if (path === '/live-config.json' && request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(configBytes);
          return;
        }
        if (path === '/rpc' && request.method === 'POST') {
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const upstream = await fetch(rpcUrl, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
          response.writeHead(upstream.status, { 'content-type': 'application/json',
            'cache-control': 'no-store' });
          response.end(Buffer.from(await upstream.arrayBuffer()));
          return;
        }
        if (path.startsWith('/v1/')) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const result = await mf.dispatchFetch(`${origin}${request.url ?? '/'}`, {
            method: request.method, headers: request.headers as Record<string, string>,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          });
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        const relative = path === '/' || path === '/app' ? 'index.html' : path.slice(1);
        const file = resolve(site, relative);
        if (!file.startsWith(`${site}/`) && file !== join(site, 'index.html')) {
          response.writeHead(403); response.end(); return;
        }
        let bytes: Buffer;
        try { bytes = await readFile(file); }
        catch { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
        response.end(bytes);
      } catch {
        response.writeHead(503); response.end();
      }
    });
    await new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(httpsPort, '127.0.0.1', done);
    });
    return { origin, appUrl: `${origin}/app`, deploymentId, rpcUrl,
      browserRpcUrl: `${origin}/rpc`, accountPrivateKey: deployerKey,
      accountAddress: deployer.address, operatorPrivateKey: operatorKey,
      rewardAvailableWei, coreManifest, connectionManifest, liveConfigSha256: config.sha256, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
