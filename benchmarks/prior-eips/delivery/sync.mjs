import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { testKeySeeds } from './test-keys.mjs';

const SOURCE_COMMIT = '639baaf7b29c22eb43ba6150140902ea8dbbbc46';
const args = parseArgs(process.argv.slice(2));
const ref = resolve(required(args, 'reference'));
const actualCommit = execFileSync('git', ['-C', ref, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualCommit !== SOURCE_COMMIT) throw new Error(`reference commit ${actualCommit} differs from ${SOURCE_COMMIT}`);
const delivery = JSON.parse(await readFile(required(args, 'delivery'), 'utf8'));
const outputPath = required(args, 'output');
const rpcUrl = required(args, 'rpc-url');
const fromBlock = Number(required(args, 'from-block'));
const toBlock = args['to-block'] === undefined ? 'latest' : Number(args['to-block']);
const sdk = join(ref, 'sepolia-demo', 'dist');
const [{ generateRecipientEncryptionKeyPair }, { trialDecryptNotePayload }, indexerModule] = await Promise.all([
  import(pathToFileURL(join(sdk, 'envelope.js')).href),
  import(pathToFileURL(join(sdk, 'trial-decrypt.js')).href),
  import(pathToFileURL(join(sdk, 'indexer.js')).href)
]);
const requireFromDemo = createRequire(join(ref, 'sepolia-demo', 'package.json'));
const { ethers } = requireFromDemo('ethers');

if (delivery.sourceCommit !== SOURCE_COMMIT) throw new Error('delivery source commit mismatch');
const provider = new ethers.JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (BigInt(delivery.chainId) !== network.chainId) throw new Error('RPC chain ID differs from encrypted payload');
const candidates = delivery.slots.map((slot) => {
  const keyPair = generateRecipientEncryptionKeyPair({
    ...testKeySeeds(slot.outputIndex),
    ownerNullifierKeyHash: slot.ownerNullifierKeyHash
  });
  if (keyPair.publicKey.keyId !== slot.recipientKeyId) throw new Error(`slot ${slot.outputIndex}: recipient key ID mismatch`);
  return { id: `test-slot-${slot.outputIndex}`, secretKey: keyPair.secretKey };
});
const iface = new ethers.Interface(indexerModule.SHIELDED_POOL_EVENT_ABI);
const eventNames = ['ShieldedPoolDeposit', 'ShieldedPoolTransact'];
const topics = eventNames.map((name) => iface.getEvent(name).topicHash);
const syncStart = performance.now();
const tFetch0 = performance.now();
const logs = await provider.getLogs({
  address: delivery.poolAddress,
  fromBlock,
  toBlock,
  topics: [topics]
});
const fetchMs = performance.now() - tFetch0;
const indexer = new indexerModule.SepoliaDemoIndexer({
  chainId: delivery.chainId,
  poolAddress: delivery.poolAddress,
  candidates
});
let trialDecryptMs = 0;
let indexMs = 0;
let trialAttempts = 0;
let outputCount = 0;
const events = [];
for (const log of logs) {
  const parsed = iface.parseLog(log);
  if (!parsed) continue;
  const outputBytes = parsed.name === 'ShieldedPoolDeposit'
    ? [parsed.args.outputNoteData]
    : [parsed.args.outputNoteData0, parsed.args.outputNoteData1, parsed.args.outputNoteData2];
  const trials = [];
  for (const bytes of outputBytes) {
    outputCount += 1;
    const t0 = performance.now();
    const result = await trialDecryptNotePayload(bytes, candidates);
    trialDecryptMs += performance.now() - t0;
    trialAttempts += result === null ? candidates.length : candidates.findIndex((x) => x.id === result.candidateId) + 1;
    trials.push(result?.candidateId ?? null);
  }
  const common = {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.index
  };
  const tIndex0 = performance.now();
  const notes = parsed.name === 'ShieldedPoolDeposit'
    ? [await indexer.ingestDeposit({
      ...common,
      depositor: parsed.args.depositor,
      noteCommitment: parsed.args.noteCommitment,
      leafIndex: parsed.args.leafIndex,
      amount: parsed.args.amount,
      tokenAddress: parsed.args.tokenAddress,
      outputNoteData: parsed.args.outputNoteData
    })]
    : await indexer.ingestTransact({
      ...common,
      noteCommitment0: parsed.args.noteCommitment0,
      noteCommitment1: parsed.args.noteCommitment1,
      noteCommitment2: parsed.args.noteCommitment2,
      leafIndex0: parsed.args.leafIndex0,
      outputNoteData0: parsed.args.outputNoteData0,
      outputNoteData1: parsed.args.outputNoteData1,
      outputNoteData2: parsed.args.outputNoteData2
    });
  indexMs += performance.now() - tIndex0;
  events.push({
    event: parsed.name,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    outputBytes: outputBytes.map((x) => (x.length - 2) / 2),
    trialMatches: trials,
    notes: notes.map((note) => ({
      id: note.id,
      status: note.status,
      outputIndex: note.outputIndex,
      outputNoteDataHash: note.outputNoteDataHash.toString(),
      noteCommitment: note.noteCommitment.toString(),
      amount: note.payload?.amount.toString() ?? null,
      decryptedBy: note.decryptedBy ?? null
    }))
  });
}

const matchedOutputHashes = new Set(indexer.store.all()
  .filter((note) => note.status === 'decrypted')
  .map((note) => note.outputNoteDataHash.toString()));
const expectedHashes = delivery.outputNoteDataHash;
const expectedReceived = expectedHashes.map((hash) => matchedOutputHashes.has(hash));
const result = {
  schemaVersion: 1,
  sourceCommit: SOURCE_COMMIT,
  chainId: delivery.chainId,
  poolAddress: delivery.poolAddress,
  fromBlock,
  toBlock,
  historyLogCount: logs.length,
  outputCount,
  trialAttempts,
  fetchMs,
  trialDecryptMs,
  indexMs,
  syncWallMs: performance.now() - syncStart,
  expectedReceived,
  allExpectedReceived: expectedReceived.every(Boolean),
  events
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.allExpectedReceived) process.exitCode = 2;

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i]?.startsWith('--') || values[i + 1] === undefined) throw new Error('expected --name value arguments');
    out[values[i].slice(2)] = values[i + 1];
  }
  return out;
}

function required(values, key) {
  if (!values[key]) throw new Error(`missing --${key}`);
  return values[key];
}
