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
const witness = JSON.parse(await readFile(required(args, 'witness'), 'utf8'));
const chainId = BigInt(required(args, 'chain-id'));
if (chainId !== BigInt(witness.executionChainId)) throw new Error('delivery chain ID differs from pool witness');
const poolAddress = required(args, 'pool-address');
const outputPath = required(args, 'output');
const sdk = join(ref, 'sepolia-demo', 'dist');
const [{ generateRecipientEncryptionKeyPair }, { prepareEncryptedOutputNoteData }, payload, poseidon] = await Promise.all([
  import(pathToFileURL(join(sdk, 'envelope.js')).href),
  import(pathToFileURL(join(sdk, 'output-notes.js')).href),
  import(pathToFileURL(join(sdk, 'payload.js')).href),
  import(pathToFileURL(join(sdk, 'poseidon.js')).href)
]);

if (!Array.isArray(witness.outAmount) || witness.outAmount.length !== 3 ||
    !Array.isArray(witness.outOwnerNullifierKeyHash) || witness.outOwnerNullifierKeyHash.length !== 3 ||
    !Array.isArray(witness.outIsReal) || witness.outIsReal.some((x) => BigInt(x) !== 1n)) {
  throw new Error('prepare requires the unmodified three-real-output root witness');
}

const tokenAddress = `0x${BigInt(witness.tokenAddress).toString(16).padStart(40, '0')}`;
const records = [];
for (let i = 0; i < 3; i += 1) {
  const ownerNullifierKeyHash = BigInt(witness.outOwnerNullifierKeyHash[i]);
  const noteSecret = poseidon.transactNoteSecret(witness.senderNoteSecretSeed, witness.intentReplayId, i);
  const ownerCommitment = poseidon.ownerCommitment(ownerNullifierKeyHash, noteSecret);
  const noteBodyCommitment = poseidon.noteBodyCommitment(ownerCommitment, witness.outAmount[i], tokenAddress);
  if (noteBodyCommitment !== BigInt(witness[`noteBodyCommitment${i}`])) {
    throw new Error(`slot ${i}: calculated note body does not match pool witness`);
  }
  const keyPair = generateRecipientEncryptionKeyPair(testKeySeeds(i));
  const t0 = performance.now();
  const prepared = await prepareEncryptedOutputNoteData({
    payload: {
      kind: 'transact', chainId, poolAddress, tokenAddress,
      amount: witness.outAmount[i], ownerNullifierKeyHash, noteSecret,
      noteBodyCommitment, outputIndex: i
    },
    recipient: keyPair.publicKey
  });
  const encryptMs = performance.now() - t0;
  if (prepared.outputNoteDataHash !== payload.outputNoteDataHash(prepared.outputNoteData)) {
    throw new Error(`slot ${i}: envelope hash mismatch`);
  }
  records.push({
    outputIndex: i,
    outputNoteDataHex: `0x${Buffer.from(prepared.outputNoteData).toString('hex')}`,
    outputNoteDataHash: prepared.outputNoteDataHash.toString(),
    byteLength: prepared.outputNoteData.length,
    encryptMs,
    noteBodyCommitment: noteBodyCommitment.toString(),
    amount: BigInt(witness.outAmount[i]).toString(),
    ownerNullifierKeyHash: ownerNullifierKeyHash.toString(),
    recipientKeyId: keyPair.publicKey.keyId
  });
}

const result = {
  schemaVersion: 1,
  sourceCommit: SOURCE_COMMIT,
  deliverySuite: 'EIP8182_SEPOLIA_DEMO_MLKEM768_X25519_HKDFSHA256_AESGCM256',
  chainId: chainId.toString(),
  poolAddress: payload.normalizeAddress(poolAddress),
  outputNoteDataHex: records.map((x) => x.outputNoteDataHex),
  outputNoteDataHash: records.map((x) => x.outputNoteDataHash),
  slots: records,
  totalEncryptMs: records.reduce((sum, x) => sum + x.encryptMs, 0),
  totalBytes: records.reduce((sum, x) => sum + x.byteLength, 0)
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);

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
