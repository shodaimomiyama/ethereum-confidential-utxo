import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createPublicClient, createWalletClient, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { adapterAbi } from '../../../packages/uniswap/src/generated/adapter-abi.js';
import { readOwnerState } from '../../../packages/cli/src/state.js';
import { createServiceClient } from '../../../packages/cli/src/service-client.js';
import { deployPool } from '../../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../../scripts/uniswap-local.mjs';
import { deployConnection } from '../../../scripts/uniswap-integration.mjs';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const bin = join(root, 'packages/cli/dist/bin.js');
const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const sourceKey = `0x${'31'.repeat(32)}` as const;
const bKey = `0x${'32'.repeat(32)}` as const;
const cKey = `0x${'33'.repeat(32)}` as const;
const submitterKey = `0x${'34'.repeat(32)}` as const;
const source = privateKeyToAccount(sourceKey);
const b = privateKeyToAccount(bKey);
const c = privateKeyToAccount(cKey);
const submitter = privateKeyToAccount(submitterKey);
const deploymentId = 'cli-replay-g1';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('PORT'));
      server.close(() => resolvePort(addr.port));
    });
  });
}

async function startAnvil(): Promise<{ url: string; close(): void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--port', String(port),
    '--chain-id', '31337', '--hardfork', 'cancun', '--gas-limit', '30000000'], { stdio: 'ignore' });
  const rpc = createPublicClient({ transport: http(url) });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('ANVIL_EXITED');
    try { if (await rpc.getChainId() === 31337) return { url, close: () => child.kill('SIGTERM') }; }
    catch { /* wait for Anvil */ }
    await new Promise(done => setTimeout(done, 100));
  }
  child.kill('SIGTERM');
  throw new Error('ANVIL_TIMEOUT');
}

async function startLostSendProxy(target: string): Promise<{
  url: string; sends: number; acceptedHash?: `0x${string}`; upstreamError?: string;
  close(): Promise<void> }> {
  let sends = 0;
  let acceptedHash: `0x${string}` | undefined;
  let upstreamError: string | undefined;
  const server = createHttpServer(async (req, res) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const method = (JSON.parse(body.toString()) as { method?: string }).method;
      if (method === 'eth_sendRawTransaction') {
        sends++;
        if (sends > 1) { res.writeHead(503); res.end(); return; }
      }
      const upstream = await fetch(target, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body });
      if (method === 'eth_sendRawTransaction') {
        const reply = await upstream.clone().json() as { result?: string; error?: { code?: number } };
        if (reply.result?.startsWith('0x')) acceptedHash = reply.result as `0x${string}`;
        else upstreamError = `status=${upstream.status} code=${reply.error?.code ?? 'none'}`;
        // Anvil has accepted the signed transaction; discard only the RPC response.
        res.writeHead(503); res.end(); return;
      }
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(503); res.end(); }
  });
  const port = await freePort();
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, get sends() { return sends; },
    get acceptedHash() { return acceptedHash; }, get upstreamError() { return upstreamError; }, close: () =>
    new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

async function startLowGasProxy(target: string, gas: bigint): Promise<{
  url: string; estimates: number; close(): Promise<void> }> {
  let estimates = 0;
  const server = createHttpServer(async (req, res) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const call = JSON.parse(body.toString()) as { id: number; method?: string };
      if (call.method === 'eth_estimateGas') {
        estimates++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: `0x${gas.toString(16)}` }));
        return;
      }
      const upstream = await fetch(target, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(503); res.end(); }
  });
  const port = await freePort();
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, get estimates() { return estimates; }, close: () =>
    new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

async function anvilRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (!response.ok || body.error) throw new Error(`ANVIL_RPC_${method}`);
  return body.result;
}

type CliOutput = Record<string, string> & { operationId: string; txHash: string;
  paymentId: string; requestId: string; status: string; kind: string };
async function runCli(script: string, args: string[]): Promise<CliOutput> {
  const { result, code } = await runCliResult(script, args);
  expect(code, `${args.slice(0, 2).join(' ')}: ${JSON.stringify(result)}`).toBe(0);
  expect(result.kind).not.toBe('error');
  return result;
}
async function runCliResult(script: string, args: string[]): Promise<{ result: CliOutput; code: number }> {
  const child = spawn('expect', [script, process.execPath, bin, ...args, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const code = await new Promise<number>((done, reject) => {
    child.once('exit', value => done(value ?? -1)); child.once('error', reject);
  });
  const lines = output.split(/\r?\n/).filter(line => line.startsWith('{'));
  expect(lines, output).toHaveLength(1);
  const result = JSON.parse(lines[0]!) as CliOutput;
  return { result, code };
}

async function service(rootDir: string, rpcUrl: string, manifest: unknown,
  pool: string, receiptKey: string, initialize = true): Promise<{
    url: string; close(): Promise<void>; dropNext(method: string, path: string): void }> {
  const generated = join(rootDir, 'service-bundle.mjs');
  await build({ stdin: { contents: `import app, { UniswapServiceObject } from './apps/uniswap-service/src/index.ts';
    export { UniswapServiceObject };
    export default { fetch(request, env) {
      const url = new URL(request.url);
      const forwarded = new Request('https://site.test' + url.pathname + url.search,
        request.method === 'GET' ? { headers: request.headers } : {
          method: request.method, headers: request.headers, body: request.body, duplex: 'half'
        });
      return app.fetch(forwarded, env);
    } };`, resolveDir: root, sourcefile: 'cli-replay-service.ts', loader: 'ts' },
    outfile: generated, bundle: true, format: 'esm', platform: 'browser',
    external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'webcrypto', setup(api) {
      api.onResolve({ filter: /^crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' }));
      api.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        contents: 'export const webcrypto = globalThis.crypto;', loader: 'js',
      }));
    } }] });
  const mf = new Miniflare({ script: await readFile(generated, 'utf8'), modules: true,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { UNISWAP_STATE: { className: 'UniswapServiceObject', useSQLite: true } },
    durableObjectsPersist: join(rootDir, 'do'), bindings: {
      DEPLOYMENTS_JSON: JSON.stringify({ [deploymentId]: { origin: 'https://site.test',
        siweUri: 'https://site.test/', chainId: 31337, pool, finalityMode: 'local-simulated' } }),
      RECOVERY_JSON: JSON.stringify({ [deploymentId]: { generation: 'g1', stopped: false, initialize: true } }),
      RPC_DEPLOYMENTS_JSON: JSON.stringify({ [deploymentId]: { url: rpcUrl, manifest } }),
      REWARD_SECRETS_JSON: JSON.stringify({ [deploymentId]: { ownerPrivateKey: sourceKey,
        receiptKey, stateKey: `0x${'35'.repeat(32)}` } }),
    } });
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('UNISWAP_STATE');
  const id = namespace.idFromName(deploymentId);
  if (initialize) await (namespace.get(id) as unknown as { initializeForDeployment(value: string): Promise<void> })
    .initializeForDeployment(deploymentId);
  const drops: { method: string; path: string }[] = [];
  const server = createHttpServer(async (req, res) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://localhost${req.url ?? '/'}`, {
        method: req.method, headers: req.headers as HeadersInit,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await mf.dispatchFetch(request.url, {
        method: request.method, headers: Object.fromEntries(request.headers),
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const index = drops.findIndex(item => item.method === req.method &&
        item.path === new URL(req.url ?? '/', 'http://localhost').pathname);
      if (index >= 0) {
        drops.splice(index, 1);
        res.writeHead(503); res.end();
        return;
      }
      if (response.status >= 400) {
        const body: unknown = await response.clone().json().catch(() => undefined);
        const error = body && typeof body === 'object' && 'error' in body
          ? (body as { error?: { code?: unknown } }).error?.code : undefined;
        process.stderr.write(`service ${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname} ${response.status} ${String(error ?? '')}\n`);
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503); res.end(); }
  });
  const port = await freePort();
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, dropNext: (method, path) => {
    drops.push({ method, path });
  }, close: async () => {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await mf.dispose();
  } };
}

it('starts the real service and accepts a scoped SIWE challenge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecu-service-smoke-'));
  let server: Awaited<ReturnType<typeof service>> | undefined;
  try {
    server = await service(dir, 'http://127.0.0.1:1', {}, `0x${'11'.repeat(20)}`, `0x${'22'.repeat(32)}`);
    const response = await fetch(`${server.url}/v1/auth/challenge`, { method: 'POST',
      headers: { origin: 'https://site.test', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { deploymentId, owner: b.address } }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const client = createServiceClient({ baseUrl: server.url, origin: 'https://site.test',
      siweUri: 'https://site.test/', chainId: 31337,
      scope: { deploymentId: deploymentId as never, owner: b.address as never }, signer: b });
    await client.authenticate();
    expect(await client.listRewards()).toEqual([]);
    expect((await client.reservations.list({ deploymentId: deploymentId as never,
      owner: b.address as never })).availability).toBe('healthy');
  } finally { await server?.close(); await rm(dir, { recursive: true, force: true }); }
}, 30_000);

it.each(['normal', 'faults'] as const)('%s: replays reward, separate-submitter Pay, and confidential change transfer', async mode => {
  const faults = mode === 'faults';
  const dir = await mkdtemp(join(tmpdir(), 'ecu-cli-replay-'));
  const script = join(dir, 'terminal.exp');
  await writeFile(script, 'set timeout 120\nspawn {*}$argv\nexpect {\n  -re {(Passphrase|passphrase): } { send -- "secret\\r"; exp_continue }\n  eof {}\n}\nexit [lindex [wait] 3]\n');
  const anvil = await startAnvil();
  let server: Awaited<ReturnType<typeof service>> | undefined;
  try {
    const rpc = createPublicClient({ transport: http(anvil.url) });
    const deployer = privateKeyToAccount(deployerKey);
    const wallet = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.url) });
    const assets = await deployLocalAssets({ url: anvil.url, chainId: 31337, generation: 'cli-replay-test',
      holder: deployer.address, lpRecipient: deployer.address });
    const corePool = await deployPool({ rpcUrl: anvil.url, expectedChainId: 31337,
      privateKey: deployerKey, hardfork: 'cancun', onDeployment: undefined });
    const manifest = await deployPool({ rpcUrl: anvil.url, expectedChainId: 31337,
      privateKey: deployerKey, hardfork: 'cancun', onDeployment: undefined });
    const poolFile = join(dir, 'pool.json');
    await writeFile(poolFile, JSON.stringify(manifest));
    const artifact = JSON.parse(await readFile(join(root, 'packages/ethereum/generated/uniswap-payment-v1.json'), 'utf8'));
    const connection = await deployConnection({ poolManifest: manifest, poolManifestPath: poolFile,
      adapterArtifact: artifact, assetManifest: assets, signer: deployer,
      publicClient: rpc, excludedPoolAddress: corePool.pool.address });
    const connectionFile = join(dir, 'connection.json');
    await writeFile(connectionFile, JSON.stringify(connection));
    const keys = join(dir, 'keys');
    await mkdir(keys, { mode: 0o700 });
    for (const [name, key] of [['source', sourceKey], ['b', bKey], ['c', cKey], ['submitter', submitterKey]] as const) {
      await writeFile(join(keys, `${name}.key`), `${key}\n`, { mode: 0o600 });
    }
    for (const account of [source, b, c, submitter]) {
      const tx = await wallet.sendTransaction({ to: account.address, value: 10n ** 18n });
      await rpc.waitForTransactionReceipt({ hash: tx });
    }
    const env = ['--manifest', poolFile, '--rpc', anvil.url];
    const connect = [...env, '--connection-manifest', connectionFile, '--deployment-id', deploymentId];
    const store = (name: string, owner: string) => ['--store', join(dir, name), '--owner', owner];
    const cli = (args: string[]) => runCli(script, args);
    for (const [name, account] of [['source', source], ['b', b], ['c', c]] as const) {
      await cli(['init', ...store(name, account.address), ...env]);
      await cli(['key', 'add', ...store(name, account.address)]);
      await cli(['recipient', ...store(name, account.address), '--signer', join(keys, `${name}.key`),
        '--out', join(dir, `${name}-recipient.json`)]);
      await cli(['sync', ...store(name, account.address), ...env]);
    }
    const amountFile = async (amount: bigint) => {
      const path = join(keys, `amount-${randomUUID()}.json`);
      await writeFile(path, JSON.stringify({ amountWei: amount.toString() }), { mode: 0o600 });
      return path;
    };
    const rewardWei = 6_000_000_000_000_000n;
    const deposit = await cli(['create', ...store('source', source.address), ...env, '--kind', 'deposit',
      '--amount-file', await amountFile(rewardWei * 2n), '--recipient', join(dir, 'source-recipient.json')]);
    await cli(['prove', ...store('source', source.address), '--id', deposit.operationId]);
    await cli(['authorize', ...store('source', source.address), '--id', deposit.operationId,
      '--signer', join(keys, 'source.key')]);
    const depositPublic = join(dir, 'deposit.json');
    await cli(['export', ...store('source', source.address), '--id', deposit.operationId, '--out', depositPublic]);
    const depositSent = await cli(['submit', '--journal', join(dir, 'deposit-journal'), ...env,
      '--signer', join(keys, 'submitter.key'), '--submitter', submitter.address, '--public', depositPublic]);
    expect((await rpc.waitForTransactionReceipt({ hash: depositSent.txHash as `0x${string}` })).status).toBe('success');
    await cli(['sync', ...store('source', source.address), ...env]);
    const sourceState = await readOwnerState(join(dir, 'source'), Buffer.from('secret'));
    const receiptKey = sourceState.receiptKeys.find(key => key.id === sourceState.activeReceiptKeyId)?.secretKey;
    expect(receiptKey).toBeDefined();
    server = await service(dir, anvil.url, manifest, manifest.pool.address, receiptKey!);
    const api = ['--api-origin', 'https://site.test', '--api-url', server.url];
    const bConnection = [...store('b', b.address), ...connect, ...api, '--signer', join(keys, 'b.key')];
    const requestId = `0x${randomBytes(32).toString('hex')}`;
    if (faults) server.dropNext('POST', '/v1/rewards');
    const reward = await cli(['reward', 'request', ...bConnection, '--request-id', requestId,
      '--amount-file', await amountFile(rewardWei)]);
    expect(reward.requestId).toBe(requestId);
    expect((await cli(['reward', 'list', ...bConnection])).entries as unknown as unknown[]).toHaveLength(1);
    const offlineConnection = [...bConnection];
    offlineConnection[offlineConnection.indexOf('--api-url') + 1] = 'http://127.0.0.1:1';
    const offlineList = await cli(['reward', 'list', ...offlineConnection]);
    expect(offlineList.entries as unknown as { requestId: string }[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId })]));
    let status = reward;
    for (let i = 0; i < 60 && status.status !== 'finalized'; i++) {
      await new Promise(done => setTimeout(done, 500));
      status = await cli(['reward', 'status', ...bConnection, '--request-id', requestId]);
    }
    expect(status.status).toBe('finalized');
    await anvilRpc(anvil.url, 'evm_mine');
    if (faults) {
      // The distributor is offline; B still decrypts and confirms the finalized output.
      await server.close();
      server = undefined;
      await cli(['sync', ...store('b', b.address), ...env]);
      const offlineReceived = await readOwnerState(join(dir, 'b'), Buffer.from('secret'));
      expect(offlineReceived.sync?.status === 'complete' && offlineReceived.sync.availableWei).toBe(rewardWei);
      server = await service(dir, anvil.url, manifest, manifest.pool.address, receiptKey!, false);
      api[api.indexOf('--api-url') + 1] = server.url;
      bConnection[bConnection.indexOf('--api-url') + 1] = server.url;
      server.dropNext('POST', `/v1/rewards/${requestId}/received`);
      const lostReceivedAck = await runCliResult(script, ['reward', 'received', ...bConnection, '--request-id', requestId]);
      expect(lostReceivedAck.code).toBe(4);
      expect(lostReceivedAck.result.kind).toBe('error');
    }
    expect((await cli(['reward', 'received', ...bConnection, '--request-id', requestId])).status).toBe('received');
    expect((await cli(['reward', 'list', ...bConnection])).entries as unknown as unknown[]).toHaveLength(1);
    const paymentWei = 3_000_000_000_000_000n;
    const tokenAbi = JSON.parse(await readFile(join(root, 'contracts/out/DemoUSD.sol/DemoUSD.json'), 'utf8')).abi;
    const token = assets.contracts.dUSD.address;
    const tokenBefore = await rpc.readContract({ address: token, abi: tokenAbi,
      functionName: 'balanceOf', args: [c.address] }) as bigint;
    const amount = await amountFile(paymentWei);
    const prepared = await cli(['pay', 'prepare', ...bConnection, '--amount-file', amount,
      '--recipient', c.address]);
    const authorized = await cli(['pay', 'authorize', ...bConnection, '--id', prepared.operationId,
      '--confirmed-content-hash', prepared.paymentId]);
    expect(authorized.status).toBe('not-submitted');
    expect(authorized.txHash).toBeUndefined();
    expect(authorized.reason).toBe('AWAITING_SUBMISSION');
    expect(authorized.allowedActions as unknown as string[]).toContain('pay submit');
    expect(parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded',
      logs: await rpc.getLogs({ address: connection.contracts.adapter.address as `0x${string}`,
        fromBlock: BigInt(connection.contracts.adapter.blockNumber) }) })).toHaveLength(0);
    let sourcePrepared: CliOutput | undefined;
    const sourceConnection = [...store('source', source.address), ...connect, ...api,
      '--signer', join(keys, 'source.key')];
    if (faults) {
      const scopedClient = createServiceClient({ baseUrl: server.url, origin: 'https://site.test',
        siweUri: 'https://site.test/', chainId: 31337,
        scope: { deploymentId: deploymentId as never, owner: b.address as never }, signer: b });
      await scopedClient.authenticate();
      const reserved = await scopedClient.reservations.get({ deploymentId: deploymentId as never,
        owner: b.address as never }, prepared.operationId as `0x${string}` as never);
      expect(reserved?.reservationState).toBe('active');
      const conflictingId = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
      await expect(scopedClient.reservations.reserve({ ...reserved!.record,
        recordId: conflictingId as never, operationId: conflictingId as never,
        contentHash: conflictingId as never, paymentId: conflictingId as never,
        signatureStarted: false, attemptIds: [] }, 0, 1))
        .rejects.toMatchObject({ code: 'RESERVATION_CONFLICT' });
      await cli(['sync', ...store('source', source.address), ...env]);
      const sourceTerms = join(keys, 'source-terms.json');
      await writeFile(sourceTerms, JSON.stringify({ minAmountOut: '1',
        deadline: ((await rpc.getBlock()).timestamp + 3_600n).toString() }), { mode: 0o600 });
      sourcePrepared = await cli(['pay', 'prepare', ...sourceConnection,
        '--amount-file', await amountFile(1_000_000_000_000_000n),
        '--recipient', c.address, '--terms-file', sourceTerms]);
    }
    const payPublic = join(dir, 'pay-public.json');
    await cli(['pay', 'export', ...store('b', b.address), ...connect,
      '--id', prepared.operationId, '--out', payPublic]);
    let payTxHash: `0x${string}` | undefined;
    let nonceBefore: number | undefined;
    if (faults) {
      // Shared service outage cannot revoke an exported authorization or block a distinct gas payer.
      await server.close();
      server = undefined;
      const stoppedAuthorize = await runCliResult(script, ['pay', 'authorize', ...sourceConnection,
        '--id', sourcePrepared!.operationId, '--confirmed-content-hash', sourcePrepared!.paymentId]);
      expect(stoppedAuthorize.result.kind).toBe('error');
      const stoppedSource = await readOwnerState(join(dir, 'source'), Buffer.from('secret'));
      expect(stoppedSource.connection?.payments[sourcePrepared!.operationId as `0x${string}`]?.poolSignature)
        .toBeUndefined();
      nonceBefore = await rpc.getTransactionCount({ address: submitter.address });
      const lossProxy = await startLostSendProxy(anvil.url);
      try {
        const lossConnect = [...connect];
        lossConnect[lossConnect.indexOf('--rpc') + 1] = lossProxy.url;
        const lostSend = await runCliResult(script, ['pay', 'submit', ...lossConnect,
          '--journal', join(dir, 'pay-journal'), '--signer', join(keys, 'submitter.key'),
          '--submitter', submitter.address, '--public', payPublic]);
        expect(lostSend.code).toBe(4);
        expect(lostSend.result.status).toBe('unknown');
        expect(lostSend.result.reason).toBe('FINALIZED_OUTCOME_UNCERTAIN');
        expect(lostSend.result.allowedActions as unknown as string[]).toContain('pay status');
        expect(lossProxy.sends).toBeGreaterThan(0);
        expect(lossProxy.acceptedHash, lossProxy.upstreamError ?? 'RAW_SEND_NOT_ACCEPTED').toBeDefined();
        payTxHash = lossProxy.acceptedHash;
      } finally { await lossProxy.close(); }
      await rpc.waitForTransactionReceipt({ hash: payTxHash! });
      const payLogs = await rpc.getLogs({ address: connection.contracts.adapter.address as `0x${string}`,
        fromBlock: BigInt(connection.contracts.adapter.blockNumber) });
      const payEvents = parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded', logs: payLogs });
      const matching = payEvents.filter(log =>
        log.args.paymentId.toLowerCase() === prepared.paymentId.toLowerCase());
      expect(matching).toHaveLength(1);
      expect(matching[0]?.transactionHash).toBe(payTxHash);
      expect(await rpc.getTransactionCount({ address: submitter.address })).toBe(nonceBefore + 1);
      server = await service(dir, anvil.url, manifest, manifest.pool.address, receiptKey!, false);
      api[api.indexOf('--api-url') + 1] = server.url;
      bConnection[bConnection.indexOf('--api-url') + 1] = server.url;
      const sourceApi = createServiceClient({ baseUrl: server.url, origin: 'https://site.test',
        siweUri: 'https://site.test/', chainId: 31337,
        scope: { deploymentId: deploymentId as never, owner: source.address as never }, signer: source });
      await sourceApi.authenticate();
      expect(await sourceApi.reservations.get({ deploymentId: deploymentId as never,
        owner: source.address as never }, sourcePrepared!.operationId as `0x${string}` as never))
        .toBeUndefined();
    } else {
      const submitted = await cli(['pay', 'submit', ...connect, '--journal', join(dir, 'pay-journal'),
        '--signer', join(keys, 'submitter.key'), '--submitter', submitter.address, '--public', payPublic]);
      payTxHash = submitted.txHash as `0x${string}`;
    }
    expect(payTxHash).toBeDefined();
    const payReceipt = await rpc.waitForTransactionReceipt({ hash: payTxHash! });
    expect(payReceipt.status).toBe('success');
    const event = parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded',
      logs: payReceipt.logs.filter(log => log.address.toLowerCase() === connection.contracts.adapter.address.toLowerCase()) });
    expect(event).toHaveLength(1);
    const tokenAfter = await rpc.readContract({ address: token, abi: tokenAbi,
      functionName: 'balanceOf', args: [c.address] }) as bigint;
    expect(tokenAfter - tokenBefore).toBe(event[0]!.args.amountOut);
    const submitterStatus = await cli(['pay', 'status', ...connect,
      '--journal', join(dir, 'pay-journal'), '--submitter', submitter.address,
      '--id', prepared.operationId]);
    expect(submitterStatus.status).toBe('finalized-success');
    if (faults) expect(await rpc.getTransactionCount({ address: submitter.address })).toBe(nonceBefore! + 1);
    await cli(['sync', ...store('b', b.address), ...env]);
    const afterPay = await readOwnerState(join(dir, 'b'), Buffer.from('secret'));
    expect(afterPay.sync?.status).toBe('complete');
    expect(afterPay.sync?.status === 'complete' && afterPay.sync.availableWei).toBe(rewardWei - paymentWei);
    const move = await cli(['create', ...store('b', b.address), ...env, '--kind', 'transfer',
      '--amount-file', await amountFile(rewardWei - paymentWei),
      '--recipient', join(dir, 'c-recipient.json')]);
    await cli(['prove', ...store('b', b.address), '--id', move.operationId]);
    await cli(['authorize', ...store('b', b.address), '--id', move.operationId,
      '--signer', join(keys, 'b.key')]);
    const moveFile = join(dir, 'move-public.json');
    await cli(['export', ...store('b', b.address), '--id', move.operationId, '--out', moveFile]);
    const moveSent = await cli(['submit', '--journal', join(dir, 'move-journal'), ...env,
      '--signer', join(keys, 'submitter.key'), '--submitter', submitter.address, '--public', moveFile]);
    const moveReceipt = await rpc.waitForTransactionReceipt({ hash: moveSent.txHash as `0x${string}` });
    expect(moveReceipt.status).toBe('success');
    await cli(['sync', ...store('c', c.address), ...env]);
    const cState = await readOwnerState(join(dir, 'c'), Buffer.from('secret'));
    expect(cState.sync?.status === 'complete' && cState.sync.availableWei).toBe(rewardWei - paymentWei);
    await cli(['sync', ...store('b', b.address), ...env]);
    const bAfterChangeSpent = await readOwnerState(join(dir, 'b'), Buffer.from('secret'));
    expect(bAfterChangeSpent.sync?.status === 'complete' && bAfterChangeSpent.sync.availableWei).toBe(0n);
    const ownerStatus = await cli(['pay', 'status', ...bConnection, '--id', prepared.operationId]);
    expect(ownerStatus.status).toBe('finalized-success');
    expect(ownerStatus.reason).toBe('PAYMENT_CONFIRMED');
    expect((ownerStatus.checkpoint as unknown as { hash?: string }).hash)
      .toBe(cState.sync?.status === 'complete' ? cState.sync.checkpoint.hash : undefined);
    const evidenceApi = createServiceClient({ baseUrl: server.url, origin: 'https://site.test',
      siweUri: 'https://site.test/', chainId: 31337,
      scope: { deploymentId: deploymentId as never, owner: b.address as never }, signer: b });
    await evidenceApi.authenticate();
    const rewardRecord = await evidenceApi.getReward(requestId as never);
    expect(rewardRecord.txHashes.length).toBeGreaterThan(0);
    const publicEvidence = { schemaVersion: 1, chainId: 31337, generation: deploymentId,
      requestId, rewardOperationId: status.operationId, paymentId: prepared.paymentId,
      payOperationId: prepared.operationId, transferOperationId: move.operationId,
      transactions: { reward: rewardRecord.txHashes, pay: payTxHash,
        transfer: moveSent.txHash },
      checkpoints: { pay: { number: payReceipt.blockNumber.toString(), hash: payReceipt.blockHash },
        transfer: { number: moveReceipt.blockNumber.toString(), hash: moveReceipt.blockHash },
        cReceipt: cState.sync?.status === 'complete' ? {
          number: cState.sync.checkpoint.number.toString(), hash: cState.sync.checkpoint.hash } : null },
      assertions: { rewardReceived: true, fullTokenDelivery: true,
        paymentAndChangeConserved: true, cReceipt: true } };
    if (faults) {
    // A second owner uses a separate input for the old-authorization expiry rule.
    const cConnection = [...store('c', c.address), ...connect, ...api,
      '--signer', join(keys, 'c.key')];
    const oldBlock = await rpc.getBlock();
    const oldDeadline = oldBlock.timestamp + 3_600n;
    const oldTerms = join(keys, 'c-old-terms.json');
    await writeFile(oldTerms, JSON.stringify({ minAmountOut: '1', deadline: oldDeadline.toString() }),
      { mode: 0o600 });
    const cPrepared = await cli(['pay', 'prepare', ...cConnection, '--amount-file',
      await amountFile(1_000_000_000_000_000n), '--recipient', b.address,
      '--terms-file', oldTerms]);
    await cli(['pay', 'authorize', ...cConnection, '--id', cPrepared.operationId,
      '--confirmed-content-hash', cPrepared.paymentId]);
    const changedTerms = join(keys, 'c-new-terms.json');
    await writeFile(changedTerms, JSON.stringify({ minAmountOut: '1',
      deadline: (oldDeadline + 3_600n).toString() }), { mode: 0o600 });
    const earlyChange = await runCliResult(script, ['pay', 'change-terms', ...cConnection,
      '--id', cPrepared.operationId, '--terms-file', changedTerms]);
    expect(earlyChange.result.kind).toBe('error');
    const beforeExpiry = await rpc.getBlock();
    await anvilRpc(anvil.url, 'evm_increaseTime', [Number(oldDeadline - beforeExpiry.timestamp + 1n)]);
    await anvilRpc(anvil.url, 'evm_mine');
    const changed = await cli(['pay', 'change-terms', ...cConnection,
      '--id', cPrepared.operationId, '--terms-file', changedTerms]);
    expect(changed.status).toBe('prepared');
    expect(changed.operationId).not.toBe(cPrepared.operationId);
    expect(changed.paymentId).not.toBe(cPrepared.paymentId);
    await cli(['pay', 'authorize', ...cConnection, '--id', changed.operationId,
      '--confirmed-content-hash', changed.paymentId]);
    const lowGasProxy = await startLowGasProxy(anvil.url, 500_000n);
    let failedAttempt: CliOutput;
    try {
      const lowGasConnection = [...cConnection];
      lowGasConnection[lowGasConnection.indexOf('--rpc') + 1] = lowGasProxy.url;
      failedAttempt = await cli(['pay', 'resume', ...lowGasConnection, '--id', changed.operationId]);
      expect(lowGasProxy.estimates).toBeGreaterThan(0);
    } finally { await lowGasProxy.close(); }
    expect(failedAttempt.status).toBe('pending');
    const failedReceipt = await rpc.waitForTransactionReceipt({ hash: failedAttempt.txHash as `0x${string}` });
    expect(failedReceipt.status).toBe('reverted');
    const retried = await cli(['pay', 'retry', ...cConnection, '--id', changed.operationId]);
    expect(retried.status).toBe('pending');
    const retryReceipt = await rpc.waitForTransactionReceipt({ hash: retried.txHash as `0x${string}` });
    expect(retryReceipt.status).toBe('success');
    const cApi = createServiceClient({ baseUrl: server.url, origin: 'https://site.test',
      siweUri: 'https://site.test/', chainId: 31337,
      scope: { deploymentId: deploymentId as never, owner: c.address as never }, signer: c });
    await cApi.authenticate();
    const retriedRecord = await cApi.reservations.get({ deploymentId: deploymentId as never,
      owner: c.address as never }, changed.operationId as `0x${string}` as never);
    expect(retriedRecord?.record.attemptIds).toHaveLength(2);
    expect(new Set(retriedRecord!.record.attemptIds).size).toBe(2);
    const expiryPoint = await rpc.getBlock();
    process.stdout.write(`CLI_REPLAY_EVIDENCE ${JSON.stringify({ ...publicEvidence,
      expiredAuthorization: { operationId: cPrepared.operationId, successorOperationId: changed.operationId,
        checkpoint: { number: expiryPoint.number.toString(), hash: expiryPoint.hash } },
      retry: { operationId: changed.operationId, attemptIds: retriedRecord!.record.attemptIds,
        failedTxHash: failedAttempt.txHash, successfulTxHash: retried.txHash,
        failedGasUsed: failedReceipt.gasUsed.toString(),
        failedBlockHash: failedReceipt.blockHash, successfulBlockHash: retryReceipt.blockHash } })}\n`);
    } else {
      process.stdout.write(`CLI_REPLAY_EVIDENCE ${JSON.stringify(publicEvidence)}\n`);
    }
  } finally {
    await server?.close();
    anvil.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
