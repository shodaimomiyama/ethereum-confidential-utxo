#!/usr/bin/env node
// Encrypt real case outputs with the upstream Sepolia demo; dummy bytes are empty.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { testKeySeeds } from '../delivery/test-keys.mjs';

const [reference, output] = process.argv.slice(2);
if (!reference || !output) throw new Error('usage: prepare-encrypted.mjs REFERENCE OUTPUT');
const root = path.resolve(reference);
const witness = JSON.parse(await fs.readFile(path.join(root, 'build/pool/input.json'), 'utf8'));
const sdk = path.join(root, 'sepolia-demo/dist');
const [{ generateRecipientEncryptionKeyPair }, { prepareEncryptedOutputNoteData }, payload, poseidon] = await Promise.all([
  import(pathToFileURL(path.join(sdk, 'envelope.js')).href),
  import(pathToFileURL(path.join(sdk, 'output-notes.js')).href),
  import(pathToFileURL(path.join(sdk, 'payload.js')).href),
  import(pathToFileURL(path.join(sdk, 'poseidon.js')).href),
]);
const chainId = BigInt(witness.executionChainId);
const poolAddress = '0x0000000000000000000000000000000000081820';
const tokenAddress = `0x${BigInt(witness.tokenAddress).toString(16).padStart(40, '0')}`;
const records = [];
for (let i = 0; i < 3; i++) {
  const real = witness.outIsReal[i] === '1';
  const ownerNullifierKeyHash = BigInt(witness.outOwnerNullifierKeyHash[i]);
  const noteSecret = poseidon.transactNoteSecret(witness.senderNoteSecretSeed, witness.intentReplayId, i);
  const ownerCommitment = poseidon.ownerCommitment(ownerNullifierKeyHash, noteSecret);
  const noteBodyCommitment = poseidon.noteBodyCommitment(ownerCommitment, witness.outAmount[i],
    real ? tokenAddress : '0x0000000000000000000000000000000000000000');
  if (noteBodyCommitment !== BigInt(witness[`noteBodyCommitment${i}`])) throw new Error(`slot ${i}: note body mismatch`);
  if (!real) {
    const empty = new Uint8Array();
    records.push({outputIndex: i, real: false, outputNoteDataHex: '0x',
      outputNoteDataHash: payload.outputNoteDataHash(empty).toString(), byteLength: 0, encryptMs: 0,
      noteBodyCommitment: noteBodyCommitment.toString(), amount: '0', ownerNullifierKeyHash: ownerNullifierKeyHash.toString()});
    continue;
  }
  const keys = generateRecipientEncryptionKeyPair(testKeySeeds(i));
  const start = performance.now();
  const prepared = await prepareEncryptedOutputNoteData({
    payload: {kind: 'transact', chainId, poolAddress, tokenAddress,
      amount: witness.outAmount[i], ownerNullifierKeyHash, noteSecret,
      noteBodyCommitment, outputIndex: i},
    recipient: keys.publicKey,
  });
  records.push({outputIndex: i, real: true,
    outputNoteDataHex: `0x${Buffer.from(prepared.outputNoteData).toString('hex')}`,
    outputNoteDataHash: prepared.outputNoteDataHash.toString(),
    byteLength: prepared.outputNoteData.length, encryptMs: performance.now() - start,
    noteBodyCommitment: noteBodyCommitment.toString(), amount: BigInt(witness.outAmount[i]).toString(),
    ownerNullifierKeyHash: ownerNullifierKeyHash.toString(), recipientKeyId: keys.publicKey.keyId});
}
const delivery = {schemaVersion: 1, sourceCommit: '639baaf7b29c22eb43ba6150140902ea8dbbbc46',
  deliverySuite: 'EIP8182_SEPOLIA_DEMO_MLKEM768_X25519_HKDFSHA256_AESGCM256',
  chainId: chainId.toString(), poolAddress: payload.normalizeAddress(poolAddress),
  outputNoteDataHex: records.map(record => record.outputNoteDataHex),
  outputNoteDataHash: records.filter(record => record.real).map(record => record.outputNoteDataHash),
  allOutputNoteDataHash: records.map(record => record.outputNoteDataHash),
  slots: records.filter(record => record.real), allSlots: records,
  totalEncryptMs: records.reduce((sum, record) => sum + record.encryptMs, 0),
  totalBytes: records.reduce((sum, record) => sum + record.byteLength, 0)};
await fs.writeFile(path.resolve(output), JSON.stringify(delivery, null, 2) + '\n');
console.log(JSON.stringify({realOutputs: delivery.slots.length, totalBytes: delivery.totalBytes, totalEncryptMs: delivery.totalEncryptMs}));
