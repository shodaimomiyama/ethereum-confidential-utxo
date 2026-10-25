#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPublicClient, decodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { authorizationTypedData, authorizeOperation, fixOperation, proveFixedOperation,
  toPublicSubmission } from '@confidential-utxo/core';
import { createOperationSigner, encodePoolSubmission, poolAbi } from '@confidential-utxo/ethereum';
import { callAtBlockHash, poolErrorSelector, preflightSepolia } from './core-sepolia.mjs';
import { validateCaseResults, writePublicEvidence } from './core-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function fail(code) { throw new Error(code); }

async function secretFile(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077)) fail('SEPOLIA_RECHECK_SECRET_PERMISSIONS');
  return (await readFile(path, 'utf8')).trim();
}

function rowById(rows, id) {
  const row = rows.find(item => item.caseId === id);
  if (!row) fail('SEPOLIA_RECHECK_CASE_MISSING');
  return row;
}

export async function recheckSepolia(args) {
  const required = ['rpc', 'manifest', 'result', 'alice-key', 'bob-key', 'alice-store',
    'passphrase-file', 'alice-recipient', 'bob-recipient'];
  if (required.some(name => !args[name])) fail('SEPOLIA_RECHECK_ARGUMENTS');
  const resultBytes = await readFile(args.result);
  const rows = JSON.parse(resultBytes.toString());
  const expected = JSON.parse(await readFile(resolve(root, 'tests/integration/core/cases.json'), 'utf8'))
    .filter(item => item.runner === 'sepolia');
  if (rows.length !== expected.length || rows.some(row => !expected.some(item => item.caseId === row.caseId)))
    fail('SEPOLIA_RECHECK_RESULT_CASES');
  const successful = rows.filter(row => row.evidence?.kind === 'transaction');
  if (successful.length !== 6 || successful.some(row => row.testOutcome !== 'pass'))
    fail('SEPOLIA_RECHECK_TRANSACTIONS_MISSING');
  const rejected = ['S-09-sepolia-unauthorized', 'S-04-sepolia-spent-input',
    'S-17-sepolia-deposit-reuse'];
  if (rejected.some(id => rowById(rows, id).testOutcome !== 'not-run'))
    fail('SEPOLIA_RECHECK_ALREADY_COMPLETE');
  const manifestBytes = await readFile(args.manifest);
  const manifest = JSON.parse(manifestBytes.toString());
  const network = rows[0].network;
  if (!network || !same(network.pool, manifest.pool.address) ||
      network.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex'))
    fail('SEPOLIA_RECHECK_MANIFEST_MISMATCH');
  const client = createPublicClient({ chain: sepolia, transport: http(args.rpc) });
  const { verified } = await preflightSepolia({ rpc: args.rpc, manifest, client });
  const checkpoint = await client.getBlock({ blockNumber: BigInt(network.finalizedBlockNumber) });
  if (!same(checkpoint.hash, network.finalizedBlockHash)) fail('SEPOLIA_RECHECK_CHECKPOINT_CHANGED');
  const head = await client.getBlock({ blockTag: 'finalized' });
  if (head.number < checkpoint.number) fail('SEPOLIA_RECHECK_CHECKPOINT_UNFINALIZED');
  for (const row of successful) {
    const tx = row.evidence.transactions[0];
    const receipt = await client.getTransactionReceipt({ hash: tx.txHash });
    if (receipt.status !== 'success' || !same(receipt.blockHash, tx.blockHash) ||
        receipt.blockNumber !== BigInt(tx.blockNumber) || receipt.blockNumber > checkpoint.number)
      fail('SEPOLIA_RECHECK_RECEIPT_MISMATCH');
  }
  const alice = privateKeyToAccount(await secretFile(args['alice-key']));
  const bob = privateKeyToAccount(await secretFile(args['bob-key']));
  const passphrase = await secretFile(args['passphrase-file']);
  const { readOwnerState } = await import('../packages/cli/dist/state.js');
  const state = await readOwnerState(args['alice-store'], Buffer.from(passphrase), undefined, alice.address);
  if (state.sync?.status !== 'complete' || !same(state.context.pool, verified.context.pool))
    fail('SEPOLIA_RECHECK_OWNER_STATE');
  const recipientInfo = async path => {
    const info = JSON.parse(await readFile(path, 'utf8'));
    return { ...info, chainId: BigInt(info.chainId) };
  };
  const recipientA = await recipientInfo(args['alice-recipient']);
  const recipientB = await recipientInfo(args['bob-recipient']);
  if (!same(recipientA.owner, alice.address) || !same(recipientB.owner, bob.address) ||
      !same(recipientA.pool, verified.context.pool) || !same(recipientB.pool, verified.context.pool))
    fail('SEPOLIA_RECHECK_RECIPIENT_MISMATCH');
  const current = state.sync.utxos.filter(item => item.status === 'available');
  if (current.length !== 1) fail('SEPOLIA_RECHECK_UNSPENT_INPUT');
  const partial = rowById(rows, 'S-03-sepolia-partial-transfer').evidence.transactions[0];
  const partialTx = await client.getTransaction({ hash: partial.txHash });
  const parsedPartial = decodeFunctionData({ abi: poolAbi, data: partialTx.input });
  if (parsedPartial.functionName !== 'transfer' || parsedPartial.args[0].inputIds.length !== 1)
    fail('SEPOLIA_RECHECK_PARTIAL_TRANSFER');
  const spent = state.sync.utxos.filter(item => item.status === 'spent' &&
    same(item.id, parsedPartial.args[0].inputIds[0]));
  if (spent.length !== 1) fail('SEPOLIA_RECHECK_SPENT_INPUT');
  const make = async (input, amount, to, change) => {
    const proved = proveFixedOperation(await fixOperation({ kind: 1, owner: alice.address,
      amount, recipient: to, changeRecipient: change }, verified.context,
    { inputs: [input], randomSalt: () => randomBytes(32) }));
    return proved;
  };
  const unspent = await make(current[0], 1n, recipientA, recipientA);
  const wrongSignature = await bob.signTypedData(authorizationTypedData(verified.context, unspent.request));
  const unauthorized = encodePoolSubmission(toPublicSubmission({ ...unspent,
    signature: wrongSignature }));
  // The local selector accepts available inputs; this candidate intentionally reuses a spent note.
  const competitor = await make({ ...spent[0], status: 'available' }, 4n, recipientB, recipientA);
  if (same(competitor.operationId, partial.operationId)) fail('SEPOLIA_RECHECK_SPENT_ID_REUSED');
  const competitorSignature = await authorizeOperation(verified.context, competitor.request,
    createOperationSigner(alice, alice.address));
  const spentCall = encodePoolSubmission(toPublicSubmission({ ...competitor,
    signature: competitorSignature }));
  const deposit = rowById(rows, 'S-01-sepolia-deposit').evidence.transactions[0];
  const depositTx = await client.getTransaction({ hash: deposit.txHash });
  const submitter = network.submitter;
  const probes = [
    [rejected[0], unauthorized.data, unauthorized.value, 'InvalidAuthorization'],
    [rejected[1], spentCall.data, spentCall.value, 'InputAlreadySpent'],
    [rejected[2], depositTx.input, depositTx.value, 'OperationAlreadyExecuted'],
  ];
  const evidence = new Map();
  for (const [id, data, value, errorName] of probes) {
    const observed = await callAtBlockHash(client, { to: verified.context.pool,
      data, value, account: submitter }, checkpoint.hash, checkpoint.number);
    if (!same(observed.selector, poolErrorSelector(errorName)))
      fail('SEPOLIA_RECHECK_SELECTOR_MISMATCH');
    evidence.set(id, { kind: 'rejection', source: 'scripts/core-sepolia-recheck.mjs',
      testName: id, errorSelector: observed.selector, blockNumber: String(checkpoint.number),
      blockHash: checkpoint.hash,
      calldataSha256: createHash('sha256').update(Buffer.from(data.slice(2), 'hex')).digest('hex'),
      from: submitter, valueWei: String(value) });
  }
  const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const recheckCommit = commit.trim();
  const completed = rows.map(row => evidence.has(row.caseId) ? {
    ...row, operationOutcome: 'rejected', testOutcome: 'pass', commit: recheckCommit,
    execution: { durationMs: row.execution.durationMs, timeoutMs: row.execution.timeoutMs },
    evidence: evidence.get(row.caseId),
  } : { ...row, execution: { durationMs: row.execution.durationMs,
    timeoutMs: row.execution.timeoutMs } });
  validateCaseResults(expected, completed);
  const temp = `${args.result}.${randomUUID()}`;
  await writePublicEvidence(temp, completed);
  await rename(temp, args.result);
  return args.result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ['rpc', 'manifest', 'result', 'alice-key', 'bob-key', 'alice-store',
    'passphrase-file', 'alice-recipient', 'bob-recipient'];
  const args = {};
  const values = process.argv.slice(2);
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i]?.startsWith('--') || !names.includes(values[i].slice(2)) || !values[i + 1])
      fail('SEPOLIA_RECHECK_ARGUMENTS');
    args[values[i].slice(2)] = values[i + 1];
  }
  try { console.log(await recheckSepolia(args)); }
  catch (error) { console.error(/^SEPOLIA_[A-Z_]+$/.test(error.message) ? error.message :
    'SEPOLIA_RECHECK_FAILED'); process.exitCode = 1; }
}
