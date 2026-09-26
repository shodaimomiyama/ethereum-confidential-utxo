#!/usr/bin/env node
// Recompute encrypted-case evidence from saved receipts, delivery and sync files.
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const raw = path.join(root, 'encrypted');
const names = fs.readdirSync(raw).filter(name => fs.existsSync(path.join(raw, name, 'status.json'))).sort();
const cases = names.map(name => {
  const dir = path.join(raw, name);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  if (status.status !== 'passed') return {name, status: 'failed', evidence: status.evidence};
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipts.json'), 'utf8'));
  const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timings.json'), 'utf8'));
  const delivery = JSON.parse(fs.readFileSync(path.join(dir, 'delivery.json'), 'utf8'));
  const sync = JSON.parse(fs.readFileSync(path.join(dir, 'sync.json'), 'utf8'));
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'pool-input.json'), 'utf8'));
  const transact = receipt.receipts.find(row => row.name === 'transact');
  if (!transact || transact.status !== 1 || !sync.allExpectedReceived) throw new Error(`${name}: receipt or recovery failed`);
  const recoveredNotes = sync.events.flatMap(event => event.notes).filter(note => note.status === 'decrypted');
  for (let i = 0; i < 3; i++) {
    if (delivery.allSlots[i].real !== (input.outIsReal[i] === '1')) throw new Error(`${name}: slot ${i} realness mismatch`);
    if (delivery.allSlots[i].outputNoteDataHash !== input[`outputNoteDataHash${i}`]) throw new Error(`${name}: slot ${i} hash mismatch`);
    if (input.outIsReal[i] === '0' && (delivery.outputNoteDataHex[i] !== '0x' || delivery.allSlots[i].byteLength !== 0)) throw new Error(`${name}: dummy slot ${i} has bytes`);
    if (receipt.state.selfControlledOutputs?.[i]) {
      const commitment = receipt.state.createdNoteCommitments[i];
      if (commitment === receipt.state.firstSpentNoteCommitment ||
          !recoveredNotes.some(note => note.noteCommitment === commitment && note.amount === input.outAmount[i])) {
        throw new Error(`${name}: self output ${i} is not a distinct recovered note`);
      }
    }
  }
  return {name, status: 'passed', asset: receipt.asset,
    inputs: input.inAmount, inputIsReal: input.inIsReal,
    outputs: input.outAmount, outputIsReal: input.outIsReal,
    publicAmountOut: input.publicAmountOut,
    depositGas: receipt.receipts.filter(row => row.name.startsWith('deposit_')).map(row => row.gasUsed),
    policyRegistrationGas: receipt.receipts.find(row => row.name === 'set_auth_policy').gasUsed,
    transactGas: transact.gasUsed, outputNoteDataBytes: transact.outputNoteDataBytes,
    poolProveMs: timing.poolProveMs, authProveMs: timing.authProveMs,
    totalEncryptMs: delivery.totalEncryptMs, totalEncryptedBytes: delivery.totalBytes,
    historyLogCount: sync.historyLogCount, trialAttempts: sync.trialAttempts,
    syncFetchMs: sync.fetchMs, syncDecryptMs: sync.trialDecryptMs, syncIndexMs: sync.indexMs,
    syncWallMs: sync.syncWallMs, expectedReceived: sync.expectedReceived,
    recipientPublicAssetDelta: receipt.state.recipientAssetDelta,
    finalPoolAssetBalance: receipt.state.poolAssetBalance,
    firstSpentNoteCommitment: receipt.state.firstSpentNoteCommitment,
    createdNoteCommitments: receipt.state.createdNoteCommitments,
    selfControlledOutputs: receipt.state.selfControlledOutputs,
    recoveredNotes: recoveredNotes.map(note => ({outputIndex: note.outputIndex, amount: note.amount, noteCommitment: note.noteCommitment})),
    receiptPath: `encrypted/${name}/receipts.json`, deliveryPath: `encrypted/${name}/delivery.json`, syncPath: `encrypted/${name}/sync.json`};
});
const result = {source: 'separate encrypted-output case receipts and sync', runsPerCase: 1,
  successful: cases.filter(row => row.status === 'passed').length, cases};
fs.writeFileSync(path.join(root, 'encrypted-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({successful: result.successful, total: cases.length, output: path.join(root, 'encrypted-summary.json')}));
