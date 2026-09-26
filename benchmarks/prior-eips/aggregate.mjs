#!/usr/bin/env node
// Rebuild the summary using only checked-in raw trial JSON.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? path.join(import.meta.dirname, 'raw/repeated');
const trials = ['warmup', 'trial-1', 'trial-2', 'trial-3'];
const gasForBytes = (hex) => {
  const bytes = Buffer.from(hex.slice(2), 'hex');
  let gas = 0;
  for (const b of bytes) gas += b === 0 ? 4 : 16;
  return gas;
};
const payloadTailGas = (items) => items.reduce((sum, hex) => {
  const bytes = Buffer.from(hex.slice(2), 'hex');
  const lengthWord = Buffer.alloc(32);
  lengthWord.writeUInt32BE(bytes.length, 28);
  let gas = 0;
  for (const b of lengthWord) gas += b === 0 ? 4 : 16;
  for (const b of bytes) gas += b === 0 ? 4 : 16;
  gas += (32 - bytes.length % 32) % 32 * 4;
  return sum + gas;
}, 0);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const rows = trials.map(id => {
  const genesis = read(`${id}-genesis.json`);
  const receipts = read(`${id}/receipts.json`);
  const delivery = read(`${id}/delivery.json`);
  const sync = read(`${id}/sync.json`);
  const timings = read(`${id}/timings.json`);
  const transact = receipts.receipts.find(item => item.name === 'transact');
  const rejected = receipts.receipts.find(item => item.name === 'tampered_intent_digest');
  if (!transact || !rejected) throw new Error(`${id}: required receipts missing`);
  if (transact.status !== 1 || rejected.status !== 0 || !sync.allExpectedReceived || !Object.values(receipts.state).every(Boolean)) throw new Error(`${id}: acceptance failed`);
  if (Number.parseInt(genesis.timestamp, 16) !== 1735689000) throw new Error(`${id}: genesis timestamp differs`);
  const calldataGas = gasForBytes(transact.rawTransaction.input);
  const encodedPayloadGas = payloadTailGas(delivery.outputNoteDataHex);
  return {
    id,
    genesisHash: genesis.hash,
    transactHash: transact.hash,
    transactBlock: Number.parseInt(transact.rawReceipt.blockNumber, 16),
    transactGas: Number(transact.gasUsed),
    calldataGas,
    executionAndRefundGas: Number(transact.gasUsed) - 21000 - calldataGas,
    outputPayloadBytes: delivery.totalBytes,
    outputPayloadTailCalldataGas: encodedPayloadGas,
    outputPayloadMarginalTailGasVersusEmpty: encodedPayloadGas - 3 * 32 * 4,
    poolProveMs: timings.pool_prove_ms,
    authProveMs: timings.auth_prove_ms,
    encryptMs: delivery.totalEncryptMs,
    syncWallMs: sync.syncWallMs,
    syncFetchMs: sync.fetchMs,
    syncTrialDecryptMs: sync.trialDecryptMs,
    syncHistoryLogs: sync.historyLogCount,
    syncOutputCount: sync.outputCount,
    syncTrialAttempts: sync.trialAttempts,
    tamperedStatus: rejected.status,
    tamperedGas: Number(rejected.gasUsed),
    initialGas: Object.fromEntries(receipts.receipts.filter(item => item.name !== 'transact' && item.name !== 'tampered_intent_digest').map(item => [item.name, Number(item.gasUsed)]))
  };
});
const formal = rows.slice(1);
const measures = ['transactGas', 'calldataGas', 'executionAndRefundGas', 'outputPayloadBytes', 'outputPayloadTailCalldataGas', 'outputPayloadMarginalTailGasVersusEmpty', 'poolProveMs', 'authProveMs', 'encryptMs', 'syncWallMs', 'syncFetchMs', 'syncTrialDecryptMs', 'tamperedGas'];
const medians = Object.fromEntries(measures.map(key => [key, median(formal.map(row => row[key]))]));
const result = {
  source: 'raw/repeated',
  calculation: 'median of three formal trials; warmup excluded; all trials retained',
  gasAccounting: 'receipt gasUsed includes intrinsic, calldata, EVM execution and refunds. calldataGas counts 4/16 gas per calldata byte. outputPayloadTailCalldataGas counts the three ABI length words, ciphertext bytes, and zero padding; it is an in-receipt component, not an additional cost. Marginal tail subtracts the three empty ABI length words; ABI head offset changes are outside this component.',
  rows,
  formalMedians: medians
};
const out = path.join(root, 'aggregate.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({out, formalMedians: medians}, null, 2));
