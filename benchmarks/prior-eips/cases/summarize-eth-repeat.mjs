#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const source = path.join(root, 'eth-repeat');
const read = (trial, file) => JSON.parse(fs.readFileSync(path.join(source, trial, file), 'utf8'));
const trials = ['trial-1', 'trial-2', 'trial-3'].map(name => {
  const status = read(name, 'status.json');
  const receipts = read(name, 'receipts.json');
  const sync = read(name, 'sync.json');
  const delivery = read(name, 'delivery.json');
  const input = read(name, 'pool-input.json');
  const transact = receipts.receipts.find(row => row.name === 'transact');
  const recovered = sync.events.flatMap(event => event.notes).filter(note => note.status === 'decrypted');
  if (status.status !== 'passed' || transact?.status !== 1 || !sync.allExpectedReceived ||
      receipts.asset !== 'ETH' || input.inAmount.join(',') !== '2,3' ||
      input.outAmount.join(',') !== '4,1,0' || recovered.length !== 2 ||
      recovered.map(note => note.amount).sort().join(',') !== '1,4' ||
      delivery.allSlots.filter(slot => slot.real).length !== 2) {
    throw new Error(`${name}: ETH merge or recipient recovery did not match the fixed case`);
  }
  return {name, transactGas: Number(transact.gasUsed), recoveredAmounts: recovered.map(note => note.amount),
    receiptPath: `eth-repeat/${name}/receipts.json`, syncPath: `eth-repeat/${name}/sync.json`};
});
const gas = trials.map(trial => trial.transactGas).sort((a, b) => a - b);
const result = {case: 's04_eth_transfer_2_plus_3', repetitions: trials.length,
  measure: 'eth_getTransactionReceipt.gasUsed', medianTransactGas: gas[1], trials};
fs.writeFileSync(path.join(root, 'eth-repeat-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({medianTransactGas: result.medianTransactGas, repetitions: trials.length}));
