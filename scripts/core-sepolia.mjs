#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeEventLog, http, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { authorizationTypedData, authorizeOperation, fixOperation, proveFixedOperation,
  toPublicSubmission } from '@confidential-utxo/core';
import { createOperationSigner, encodePoolSubmission, poolAbi, verifyEthereumDeployment } from '@confidential-utxo/ethereum';
import { validateCaseResults, writePublicEvidence } from './core-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hex32 = /^0x[0-9a-f]{64}$/i;
const hex4 = /^0x[0-9a-f]{8}$/i;
const usage = 'core-sepolia --rpc HTTPS_URL --manifest FILE --owner-a-key FILE --owner-b-key FILE --submitter-key FILE --owner-a-store DIR --owner-b-store DIR --journal DIR --out FILE';
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function safeError(code) { throw new Error(code); }

export async function preflightSepolia({ rpc, manifest, client, verify = verifyEthereumDeployment }) {
  if (!rpc || !/^https:\/\//i.test(rpc)) safeError('SEPOLIA_HTTPS_REQUIRED');
  if (!manifest || manifest.chainId !== sepolia.id) safeError('SEPOLIA_MANIFEST_CHAIN');
  if (await client.getChainId() !== sepolia.id) safeError('SEPOLIA_RPC_CHAIN');
  const verified = await verify(client, manifest, 'finalized');
  const point = await client.getBlock({ blockTag: 'finalized' });
  if (!point?.hash || point.number === undefined || point.number < BigInt(manifest.pool.blockNumber ?? 0))
    safeError('SEPOLIA_FINALITY_UNAVAILABLE');
  if (point.blobGasUsed === undefined || point.excessBlobGas === undefined)
    safeError('SEPOLIA_FORK_UNVERIFIED');
  return { verified, point };
}

function revertData(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const data = Reflect.get(current, 'data');
    if (typeof data === 'string' && hex4.test(data.slice(0, 10))) return data;
    if (data && typeof data === 'object' && typeof data.data === 'string' && hex4.test(data.data.slice(0, 10)))
      return data.data;
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}

export async function callAtBlockHash(client, request, blockHash, blockNumber) {
  if (blockNumber === undefined) blockNumber = (await client.getBlock({ blockHash })).number;
  const read = () => client.getBlock({ blockNumber });
  const before = await read();
  if (!same(before.hash, blockHash)) safeError('SEPOLIA_CHECKPOINT_CHANGED');
  let selector;
  try {
    await client.request({ method: 'eth_call', params: [
      { from: request.account, to: request.to, data: request.data, value: `0x${request.value.toString(16)}` },
      { blockHash, requireCanonical: true },
    ] });
    safeError('SEPOLIA_UNEXPECTED_ACCEPTANCE');
  } catch (error) {
    if (error instanceof Error && error.message === 'SEPOLIA_UNEXPECTED_ACCEPTANCE') throw error;
    const data = revertData(error);
    if (!data) safeError('SEPOLIA_RPC_UNAVAILABLE');
    selector = data.slice(0, 10);
  }
  const after = await read();
  if (!same(after.hash, blockHash)) safeError('SEPOLIA_CHECKPOINT_CHANGED');
  return { selector };
}

export function parseSepoliaOptions(argv, environment = process.env) {
  const names = ['rpc', 'manifest', 'owner-a-key', 'owner-b-key', 'submitter-key',
    'owner-a-store', 'owner-b-store', 'journal', 'out'];
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) {
    const vars = ['SEPOLIA_RPC_URL', 'POOL_MANIFEST_PATH', 'ALICE_KEY_PATH', 'BOB_KEY_PATH',
      'SUBMITTER_KEY_PATH', 'ALICE_STORE_PATH', 'BOB_STORE_PATH', 'SUBMITTER_JOURNAL_PATH',
      'PUBLIC_RESULT_PATH'];
    const found = Object.fromEntries(names.map((name, at) => [name, environment[vars[at]]]));
    if (names.some(name => !found[name])) safeError('SEPOLIA_ENV_MISSING');
    return found;
  }
  const found = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!names.includes(name) || !argv[i + 1] || found[name]) safeError('SEPOLIA_ARGUMENTS');
    found[name] = argv[i + 1];
  }
  if (names.some(name => !found[name]) || argv.length !== names.length * 2) safeError('SEPOLIA_ARGUMENTS');
  return found;
}

function command(executable, args, input) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += String(value); });
    child.stderr.on('data', value => { stderr += String(value); });
    child.on('error', reject);
    child.on('close', code => resolveCommand({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function terminalSecret() {
  const tty = '/dev/tty';
  const fd = await import('node:fs/promises').then(fs => fs.open(tty, 'r+'));
  try {
    await fd.write('Owner store passphrase: ');
    const off = spawn('stty', ['-echo'], { stdio: [fd.fd, 'ignore', 'ignore'] });
    if (await new Promise(done => off.on('close', done))) safeError('SEPOLIA_TTY_REQUIRED');
    let value = '';
    const bytes = Buffer.alloc(1);
    for (;;) {
      await fd.read(bytes, 0, 1);
      if (bytes[0] === 10 || bytes[0] === 13) break;
      value += bytes.toString('utf8');
    }
    if (!value) safeError('SEPOLIA_PASSPHRASE_REQUIRED');
    return value;
  } finally {
    const on = spawn('stty', ['echo'], { stdio: [fd.fd, 'ignore', 'ignore'] });
    await new Promise(done => on.on('close', done));
    await fd.write('\n');
    await fd.close();
  }
}

async function cliRunner(passphrase, scriptPath) {
  const bin = join(root, 'packages/cli/dist/bin.js');
  return async args => {
    const run = await command('expect', [scriptPath, process.execPath, bin, ...args, '--json'], `${passphrase}\n`);
    const lines = run.stdout.split(/\r?\n/).filter(line => line.startsWith('{'));
    if (run.code || lines.length !== 1) safeError(`SEPOLIA_CLI_${args[0].toUpperCase()}_FAILED`);
    let result;
    try { result = JSON.parse(lines[0]); }
    catch { safeError('SEPOLIA_CLI_JSON_INVALID'); }
    if (result.kind === 'error') safeError(`SEPOLIA_CLI_${String(result.code ?? 'ERROR')}`);
    return result;
  };
}

async function finalizedReceipt(client, txHash) {
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 600_000 });
  if (receipt.status !== 'success') safeError('SEPOLIA_TRANSACTION_REVERTED');
  const deadline = Date.now() + 900_000;
  for (;;) {
    const point = await client.getBlock({ blockTag: 'finalized' });
    if (point.number >= receipt.blockNumber) {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (!same(block.hash, receipt.blockHash)) safeError('SEPOLIA_RECEIPT_REORG');
      return receipt;
    }
    if (Date.now() > deadline) safeError('SEPOLIA_FINALITY_TIMEOUT');
    await new Promise(done => setTimeout(done, 12_000));
  }
}

function requireOperationEvent(receipt, pool, id, kind, amountWei) {
  const found = receipt.logs.some(log => {
    if (!same(log.address, pool)) return false;
    try {
      const event = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics });
      return event.eventName === 'OperationSucceeded' && same(event.args.operationId, id) &&
        event.args.kind === ({ deposit: 0, transfer: 1, withdraw: 2 })[kind] &&
        event.args.d === (kind === 'deposit' ? BigInt(amountWei) : 0n) &&
        event.args.w === (kind === 'withdraw' ? BigInt(amountWei) : 0n);
    } catch { return false; }
  });
  if (!found) safeError('SEPOLIA_OPERATION_EVENT_MISSING');
}

function decodeExport(bytes) {
  const value = JSON.parse(bytes);
  const numbers = values => values.map(BigInt);
  return { request: { ...value.request, d: BigInt(value.request.d), w: BigInt(value.request.w),
    outputs: value.request.outputs.map(item => ({ ...item,
      commitment: { x: BigInt(item.commitment.x), y: BigInt(item.commitment.y) } })) },
  balanceProof: Object.fromEntries(Object.entries(value.balanceProof).map(([key, value]) => [key, BigInt(value)])),
  rangeProofs: value.rangeProofs.map(item => ({ coords: numbers(item.coords), scalars: numbers(item.scalars),
    ls: numbers(item.ls), rs: numbers(item.rs) })), signature: value.signature };
}

async function artifactHashes() {
  const entries = [['pool', 'packages/ethereum/generated/pool-v1.json'],
    ['verifier', 'packages/ethereum/generated/verifier-v3.json']];
  return Object.fromEntries(await Promise.all(entries.map(async ([name, path]) =>
    [name, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
}

export async function runSepolia(args) {
  if (!/^https:\/\//i.test(args.rpc)) safeError('SEPOLIA_HTTPS_REQUIRED');
  await access(args.manifest);
  try { await access(args.out); safeError('SEPOLIA_RESULT_EXISTS'); }
  catch (error) { if (error.message === 'SEPOLIA_RESULT_EXISTS') throw error; if (error.code !== 'ENOENT') throw error; }
  const pendingPath = `${args.out}.pending.json`;
  try { await access(pendingPath); safeError('SEPOLIA_PENDING_RESULT_EXISTS'); }
  catch (error) { if (error.message === 'SEPOLIA_PENDING_RESULT_EXISTS') throw error; if (error.code !== 'ENOENT') throw error; }
  const manifestBytes = await readFile(args.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const client = createPublicClient({ chain: sepolia, transport: http(args.rpc, { timeout: 30_000, retryCount: 0 }) });
  const { verified, point } = await preflightSepolia({ rpc: args.rpc, manifest, client });
  const actors = [];
  for (const role of ['owner-a', 'owner-b', 'submitter']) {
    const keyPath = args[`${role}-key`];
    const info = await stat(keyPath);
    if (!info.isFile() || (info.mode & 0o077)) safeError('SEPOLIA_KEY_PERMISSIONS');
    const key = (await readFile(keyPath, 'utf8')).trim();
    if (!hex32.test(key)) safeError('SEPOLIA_KEY_FORMAT');
    actors.push({ keyPath, account: privateKeyToAccount(key) });
  }
  const [alice, bob, submitter] = actors;
  if (new Set(actors.map(item => item.account.address.toLowerCase())).size !== 3) safeError('SEPOLIA_DISTINCT_KEYS_REQUIRED');
  const paths = [args['owner-a-store'], args['owner-b-store'], args.journal, args.out].map(resolve);
  if (new Set(paths).size !== paths.length) safeError('SEPOLIA_DISTINCT_PATHS_REQUIRED');
  for (const path of [...paths.slice(0, 3), `${args['owner-a-store']}.inaccessible`]) {
    try { await access(path); safeError('SEPOLIA_STATE_EXISTS'); }
    catch (error) { if (error.message === 'SEPOLIA_STATE_EXISTS') throw error; if (error.code !== 'ENOENT') throw error; }
  }
  const submitterBalance = await client.getBalance({ address: submitter.account.address });
  if (submitterBalance === 0n)
    safeError('SEPOLIA_SUBMITTER_UNFUNDED');
  const started = Date.now();
  const [pnpm, foundry, commit] = await Promise.all([
    command('pnpm', ['--version']), command('forge', ['--version']), command('git', ['rev-parse', 'HEAD'])]);
  if (pnpm.code || foundry.code || commit.code) safeError('SEPOLIA_ENVIRONMENT_UNAVAILABLE');
  const environment = { os: process.platform, arch: process.arch, node: process.versions.node,
    pnpm: pnpm.stdout.trim(), foundry: foundry.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown',
    memoryBytes: String(totalmem()) };
  const hashes = await artifactHashes();
  const expectedCases = JSON.parse(await readFile(join(root, 'tests/integration/core/cases.json'), 'utf8'))
    .filter(item => item.runner === 'sepolia');
  let network = { chainId: String(sepolia.id), pool: verified.context.pool,
    deploymentTxHash: manifest.pool.transactionHash,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    finalizedBlockNumber: String(point.number), finalizedBlockHash: point.hash,
    declaredFork: manifest.hardfork, forkBasis: 'finalized-block-blob-fields-cancun-or-later',
    rpcHost: new URL(args.rpc).hostname, rpcClient: 'viem@2.56.9',
    submitter: submitter.account.address, submitterBalanceWei: String(submitterBalance) };
  const operations = new Map();
  function results(failureReason) {
    return expectedCases.map(item => {
      const observed = operations.get(item.caseId);
      const pass = Boolean(observed?.row || observed?.rejection);
      return { schemaVersion: 1, caseId: item.caseId,
        operationOutcome: observed?.row ? 'success' : observed?.rejection ? 'rejected' :
          observed?.pending ? 'unconfirmed' : 'unavailable',
        testOutcome: pass ? 'pass' : 'not-run', commit: commit.stdout.trim(),
        artifactHashes: hashes, environment, network,
        execution: { durationMs: String(Date.now() - started), timeoutMs: '900000',
          ...(failureReason ? { failureReason } : {}) },
        evidence: observed?.rejection ?? (observed?.row ? { kind: 'transaction',
          source: 'scripts/core-sepolia.mjs', testName: item.caseId, transactions: [observed.row] } :
          { kind: 'test', source: 'scripts/core-sepolia.mjs', testName: item.caseId,
            ...(observed?.pending ? { operationId: observed.id, txHash: observed.txHash, status: 'pending' } : {}) }) };
    });
  }
  async function saveCheckpoint() {
    await mkdir(dirname(args.out), { recursive: true });
    const temp = `${pendingPath}.${randomUUID()}`;
    await writePublicEvidence(temp, results());
    await rename(temp, pendingPath);
  }
  await saveCheckpoint();
  const secret = await terminalSecret();
  const scriptPath = join(dirname(resolve(args['owner-a-store'])), `terminal-${randomUUID()}.exp`);
  await mkdir(dirname(scriptPath), { recursive: true, mode: 0o700 });
  await writeFile(scriptPath, 'set timeout 600\ngets stdin pass\nspawn {*}$argv\nexpect {\n  -re {(Passphrase|passphrase): } { send -- "$pass\\r"; exp_continue }\n  eof {}\n}\nexit [lindex [wait] 3]\n', { mode: 0o600 });
  const cli = await cliRunner(secret, scriptPath);
  const online = ['--manifest', args.manifest, '--rpc', args.rpc];
  const owner = (actor, store) => ['--store', store, '--owner', actor.account.address];
  const a = owner(alice, args['owner-a-store']);
  const b = owner(bob, args['owner-b-store']);
  const sender = ['--journal', args.journal, ...online, '--signer', submitter.keyPath,
    '--submitter', submitter.account.address];
  const privateDir = dirname(scriptPath);
  const recipient = {};
  for (const [name, actor, ownerArgs] of [['a', alice, a], ['b', bob, b]]) {
    await cli(['init', ...ownerArgs, ...online]);
    await cli(['key', 'add', ...ownerArgs]);
    await cli(['sync', ...ownerArgs, ...online]);
    recipient[name] = join(privateDir, `${name}-recipient-${randomUUID()}.json`);
    await cli(['recipient', ...ownerArgs, '--signer', actor.keyPath, '--out', recipient[name]]);
    if ((await ids(ownerArgs)).length !== 0) safeError('SEPOLIA_OWNER_NOT_FRESH');
  }
  async function sync(ownerArgs) {
    const result = await cli(['sync', ...ownerArgs, ...online]);
    if (result.status !== 'complete') safeError('SEPOLIA_SYNC_INCOMPLETE');
    return result;
  }
  async function ids(ownerArgs) {
    const value = await cli(['utxos', ...ownerArgs]);
    if (value.status !== 'complete') safeError('SEPOLIA_UTXO_INCOMPLETE');
    return value.entries.filter(row => row.status === 'available').map(row => row.id);
  }
  async function prepare(actor, ownerArgs, kind, amountWei, extra) {
    const amountFile = join(privateDir, `amount-${randomUUID()}.json`);
    await writeFile(amountFile, JSON.stringify({ amountWei }), { mode: 0o600 });
    const created = await cli(['create', ...ownerArgs, ...online, '--kind', kind,
      '--amount-file', amountFile, ...extra]);
    const id = created.operationId;
    if (!hex32.test(id)) safeError('SEPOLIA_OPERATION_ID_MISSING');
    await cli(['prove', ...ownerArgs, '--id', id]);
    await cli(['authorize', ...ownerArgs, '--id', id, '--signer', actor.keyPath]);
    const publicFile = join(privateDir, `${id}.json`);
    await cli(['export', ...ownerArgs, '--id', id, '--out', publicFile]);
    return { id, publicFile };
  }
  async function execute(name, actor, ownerArgs, kind, amountWei, extra) {
    const { id, publicFile } = await prepare(actor, ownerArgs, kind, amountWei, extra);
    operations.set(name, { pending: true, id });
    await saveCheckpoint();
    const submitted = await cli(['submit', ...sender, '--public', publicFile]);
    if (!hex32.test(submitted.txHash)) safeError('SEPOLIA_SUBMISSION_UNKNOWN');
    operations.set(name, { pending: true, id, txHash: submitted.txHash });
    await saveCheckpoint();
    const receipt = await finalizedReceipt(client, submitted.txHash);
    requireOperationEvent(receipt, verified.context.pool, id, kind, amountWei);
    const observed = await cli(['operation', ...sender, '--id', id]);
    if (observed.status !== 'executed') safeError('SEPOLIA_OPERATION_UNCONFIRMED');
    const row = { operationId: id, txHash: submitted.txHash, blockNumber: String(receipt.blockNumber),
      blockHash: receipt.blockHash, gasUsed: String(receipt.gasUsed), status: 'success' };
    operations.set(name, { row });
    await saveCheckpoint();
    return { id, publicFile, row };
  }
  const deposit = await execute('S-01-sepolia-deposit', alice, a, 'deposit', '10', ['--recipient', recipient.a]);
  await sync(a);
  const { readOwnerState } = await import('../packages/cli/dist/state.js');
  const originalState = await readOwnerState(args['owner-a-store'], Buffer.from(secret));
  if (originalState.sync?.status !== 'complete') safeError('SEPOLIA_OWNER_STATE_UNAVAILABLE');
  const recipientInfo = async path => {
    const info = JSON.parse(await readFile(path, 'utf8'));
    return { ...info, chainId: BigInt(info.chainId) };
  };
  const competitor = proveFixedOperation(await fixOperation({ kind: 1, owner: alice.account.address,
    amount: 4n, recipient: await recipientInfo(recipient.b),
    changeRecipient: await recipientInfo(recipient.a) }, verified.context,
  { inputs: originalState.sync.utxos.filter(item => item.status === 'available'), randomSalt: () => randomBytes(32) }));
  const competitorSignature = await authorizeOperation(verified.context, competitor.request,
    createOperationSigner(alice.account, alice.account.address));
  const competitorCalldata = encodePoolSubmission(toPublicSubmission({ ...competitor,
    signature: competitorSignature }));
  const transfer = await execute('S-03-sepolia-partial-transfer', alice, a, 'transfer', '3',
    ['--recipient', recipient.b, '--change-recipient', recipient.a]);
  await sync(a);
  const aIdsBefore = await ids(a);
  await execute('S-01-sepolia-second-deposit', alice, a, 'deposit', '2', ['--recipient', recipient.a]);
  await sync(a);
  const aIds = (await ids(a)).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (aIds.length !== 2 || aIdsBefore.length !== 1) safeError('SEPOLIA_MERGE_INPUTS');
  await execute('S-04-sepolia-two-input-merge', alice, a, 'transfer', '9',
    ['--recipient', recipient.a, ...aIds.flatMap(id => ['--input-id', id])]);
  await sync(a);
  const unspent = await prepare(alice, a, 'transfer', '1',
    ['--recipient', recipient.a, '--change-recipient', recipient.a]);
  const unspentSubmission = decodeExport(await readFile(unspent.publicFile, 'utf8'));
  const wrongSignature = await bob.account.signTypedData(
    authorizationTypedData(verified.context, unspentSubmission.request));
  const unauthorized = encodePoolSubmission({ ...unspentSubmission, signature: wrongSignature }).data;
  await rename(args['owner-a-store'], `${args['owner-a-store']}.inaccessible`);
  await sync(b);
  const bobIds = await ids(b);
  if (bobIds.length !== 1) safeError('SEPOLIA_BOB_RECEIPT');
  const recipientEthBefore = await client.getBalance({ address: bob.account.address });
  await execute('S-03-sepolia-independent-spend', bob, b, 'transfer', '1',
    ['--recipient', recipient.b, '--change-recipient', recipient.b]);
  await sync(b);
  await execute('S-06-sepolia-withdraw', bob, b, 'withdraw', '2',
    ['--destination', bob.account.address, '--change-recipient', recipient.b,
      ...((await ids(b)).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
        .flatMap(id => ['--input-id', id]))]);
  await sync(b);
  if (await client.getBalance({ address: bob.account.address }) !== recipientEthBefore + 2n)
    safeError('SEPOLIA_WITHDRAW_BALANCE');
  const accounting = await client.readContract({ address: verified.context.pool, abi: poolAbi,
    functionName: 'getAccounting', blockTag: 'finalized' });
  if (accounting[0] < accounting[1])
    safeError('SEPOLIA_ACCOUNTING');
  const aState = await readOwnerState(`${args['owner-a-store']}.inaccessible`, Buffer.from(secret));
  const bState = await readOwnerState(args['owner-b-store'], Buffer.from(secret));
  if (aState.sync?.status !== 'complete' || aState.sync.availableWei !== 9n ||
      bState.sync?.status !== 'complete' || bState.sync.availableWei !== 1n)
    safeError('SEPOLIA_PRIVATE_BALANCE');
  const checkpoint = await client.getBlock({ blockTag: 'finalized' });
  network = { ...network, finalizedBlockNumber: String(checkpoint.number), finalizedBlockHash: checkpoint.hash };
  if (same(competitor.operationId, transfer.id)) safeError('SEPOLIA_SPENT_ID_REUSED');
  const depositTx = await client.getTransaction({ hash: deposit.row.txHash });
  const probes = [
    ['S-09-sepolia-unauthorized', unauthorized, 0n, 'InvalidAuthorization'],
    ['S-04-sepolia-spent-input', competitorCalldata.data, competitorCalldata.value, 'InputAlreadySpent'],
    ['S-17-sepolia-deposit-reuse', depositTx.input, depositTx.value, 'OperationAlreadyExecuted'],
  ];
  let probeFailed = false;
  for (const [name, data, value, errorName] of probes) {
    const expected = toFunctionSelector(poolAbi.find(item => item.type === 'error' && item.name === errorName));
    try {
      const observed = await callAtBlockHash(client, { to: verified.context.pool, data,
        account: submitter.account.address, value }, checkpoint.hash, checkpoint.number);
      if (!same(observed.selector, expected)) safeError('SEPOLIA_REJECTION_SELECTOR_MISMATCH');
      operations.set(name, { rejection: { kind: 'rejection', source: 'scripts/core-sepolia.mjs',
        testName: name, errorSelector: observed.selector, blockNumber: String(checkpoint.number),
        blockHash: checkpoint.hash, calldataSha256: createHash('sha256').update(Buffer.from(data.slice(2), 'hex')).digest('hex'),
        from: submitter.account.address, valueWei: String(value) } });
    } catch {
      probeFailed = true;
      operations.set(name, { unavailable: true });
    }
    await saveCheckpoint();
  }
  const finalResults = results(probeFailed ? 'SEPOLIA_REJECTION_PROBE_UNAVAILABLE' : undefined);
  if (!probeFailed) validateCaseResults(expectedCases, finalResults);
  await mkdir(dirname(args.out), { recursive: true });
  await writePublicEvidence(args.out, finalResults);
  await unlink(pendingPath);
  if (probeFailed) safeError('SEPOLIA_REJECTION_PROBE_UNAVAILABLE');
  return args.out;
}

export async function finalizeFailedSepolia(args, reason, started = Date.now()) {
  const pendingPath = `${args.out}.pending.json`;
  let rows;
  const safeReason = /^SEPOLIA_[A-Z_]+$/.test(reason) ? reason : 'SEPOLIA_FAILED';
  try { rows = JSON.parse(await readFile(pendingPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await access(args.out); return false; }
    catch (exists) { if (exists.code !== 'ENOENT') throw exists; }
    const [pnpm, foundry, commit] = await Promise.all([
      command('pnpm', ['--version']), command('forge', ['--version']), command('git', ['rev-parse', 'HEAD'])]);
    if (commit.code) throw new Error('SEPOLIA_COMMIT_UNAVAILABLE');
    let hashes = {};
    try { hashes = await artifactHashes(); } catch { /* Build was not yet available. */ }
    const environment = { os: process.platform, arch: process.arch, node: process.versions.node,
      pnpm: pnpm.code ? 'unavailable' : pnpm.stdout.trim(),
      foundry: foundry.code ? 'unavailable' : foundry.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unavailable',
      memoryBytes: String(totalmem()) };
    const expectedCases = JSON.parse(await readFile(join(root, 'tests/integration/core/cases.json'), 'utf8'))
      .filter(item => item.runner === 'sepolia');
    rows = expectedCases.map(item => ({ schemaVersion: 1, caseId: item.caseId,
      operationOutcome: 'unavailable', testOutcome: 'not-run', commit: commit.stdout.trim(),
      artifactHashes: hashes, environment,
      execution: { durationMs: String(Date.now() - started), timeoutMs: '900000', failureReason: safeReason },
      evidence: { kind: 'test', source: 'scripts/core-sepolia.mjs', testName: item.caseId } }));
    await mkdir(dirname(args.out), { recursive: true });
    await writePublicEvidence(args.out, rows);
    return true;
  }
  await writePublicEvidence(args.out, rows.map(row => ({ ...row,
    execution: { ...row.execution, durationMs: String(Date.now() - started), failureReason: safeReason } })));
  await unlink(pendingPath);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  const started = Date.now();
  try {
    args = parseSepoliaOptions(process.argv.slice(2));
    const out = await runSepolia(args);
    process.stdout.write(`${out}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'SEPOLIA_FAILED';
    try { if (args) await finalizeFailedSepolia(args, reason, started); }
    catch { process.stderr.write('SEPOLIA_PENDING_RESULT_RETAINED\n'); }
    process.stderr.write(`${reason.replace(/https?:\/\/\S+/g, '[redacted RPC]')}\n${usage}\n`);
    process.exitCode = 1;
  }
}
