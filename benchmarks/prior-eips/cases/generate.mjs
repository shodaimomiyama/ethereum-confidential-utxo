#!/usr/bin/env node
// Generate fixed case witnesses from the upstream 639baaf7 Groth16 demo
// witness generator. Run against an isolated copy of the reference checkout.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [reference, caseName] = process.argv.slice(2);
const cases = {
  eth_withdraw_partial: { eth: true, withdrawal: 8, output: [5, 0, 2], real: [1, 0, 1] },
  eth_withdraw_full: { eth: true, withdrawal: 15, output: [0, 0, 0], real: [0, 0, 0] },
  erc20_withdraw_partial: { eth: false, withdrawal: 8, output: [5, 0, 2], real: [1, 0, 1] },
  erc20_withdraw_full: { eth: false, withdrawal: 15, output: [0, 0, 0], real: [0, 0, 0] },
  transfer_partial: { eth: false, withdrawal: 0, output: [8, 5, 2], real: [1, 1, 1] },
  transfer_full: { eth: false, withdrawal: 0, output: [15, 0, 0], real: [1, 0, 0] },
  merge: { eth: false, withdrawal: 0, output: [15, 0, 0], real: [1, 0, 0], self: true },
  s02_transfer_full_10: { eth: false, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [10, 0, 0], real: [1, 0, 0] },
  s03_transfer_partial_3: { eth: false, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [3, 7, 0], real: [1, 1, 0] },
  s04_transfer_2_plus_3: { eth: false, withdrawal: 0, input: [2, 3], inputReal: [1, 1], output: [4, 1, 0], real: [1, 1, 0] },
  s06_eth_withdraw_full_10: { eth: true, withdrawal: 10, input: [10, 0], inputReal: [1, 0], output: [0, 0, 0], real: [0, 0, 0] },
  s06_eth_withdraw_partial_3: { eth: true, withdrawal: 3, input: [10, 0], inputReal: [1, 0], output: [7, 0, 0], real: [1, 0, 0] },
  s05_self_split_10: { eth: false, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [3, 7, 0], real: [1, 1, 0], self: true },
  s05_self_recreate_10: { eth: false, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [10, 0, 0], real: [1, 0, 0], self: true },
  s02_eth_transfer_full_10: { eth: true, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [10, 0, 0], real: [1, 0, 0] },
  s03_eth_transfer_partial_3: { eth: true, withdrawal: 0, input: [10, 0], inputReal: [1, 0], output: [3, 7, 0], real: [1, 1, 0] },
  s04_eth_transfer_2_plus_3: { eth: true, withdrawal: 0, input: [2, 3], inputReal: [1, 1], output: [4, 1, 0], real: [1, 1, 0] },
};
if (!reference || !cases[caseName]) throw new Error(`usage: generate.mjs REFERENCE CASE; cases: ${Object.keys(cases).join(', ')}`);
const config = cases[caseName];
const root = path.resolve(reference);
const sourcePath = path.join(root, 'scripts/witness/gen_pool_witness_input.js');
let source = fs.readFileSync(sourcePath, 'utf8');
function replaceOnce(oldValue, newValue) {
  if (!source.includes(oldValue) || source.indexOf(oldValue) !== source.lastIndexOf(oldValue)) {
    throw new Error(`upstream generator changed near ${oldValue.slice(0, 60)}`);
  }
  source = source.replace(oldValue, newValue);
}
replaceOnce('const tokenAddress = 0x2222222222222222222222222222222222222222n;',
  `const tokenAddress = ${config.eth ? '0n' : '0x2222222222222222222222222222222222222222n'};`);
if (config.input) replaceOnce('const inAmount      = [10n, 5n];',
  `const inAmount      = [${config.input.map(x => `${x}n`).join(', ')}];`);
if (config.inputReal) {
  replaceOnce('const inIsReal      = [1n, 1n];',
    `const inIsReal      = [${config.inputReal.map(x => `${x}n`).join(', ')}];`);
  replaceOnce('const noteLeaves = new Map([\n  [Number(inLeafIndex[0]), inNoteCommitment[0]],\n  [Number(inLeafIndex[1]), inNoteCommitment[1]],\n]);',
    'const noteLeaves = new Map(inLeafIndex.flatMap((idx, i) => inIsReal[i] === 1n ? [[Number(idx), inNoteCommitment[i]]] : []));');
  replaceOnce('  nullifier1:                  toStr(inRealNullifier[1]),',
    '  nullifier1:                  toStr(inIsReal[1] === 1n ? inRealNullifier[1] : poseidon(T.PHANTOM_NULLIFIER_DOMAIN, senderOwnerNullifierKey, intentReplayId, 1n)),');
}
replaceOnce('const outIsReal = [1n, 1n, 1n];', `const outIsReal = [${config.real.map(x => `${x}n`).join(', ')}];`);
replaceOnce('const outAmount = [8n, 5n, 2n];', `const outAmount = [${config.output.map(x => `${x}n`).join(', ')}];`);
replaceOnce('  0xBABE0001n,                  // recipient\'s key\n  senderOwnerNullifierKey,      // sender\'s own key for change\n  0xBABE0003n,                  // fee recipient\'s key',
  `  ${config.real[0] === 0 ? '0xdeadn' : config.self || config.withdrawal ? 'senderOwnerNullifierKey' : '0xBABE0001n'},\n  ${config.real[1] ? 'senderOwnerNullifierKey' : '0xdeadn'},\n  ${config.real[2] ? '0xBABE0003n' : '0xdeadn'},`);
replaceOnce('const recipientOwnerNullifierKeyHash        = outOwnerNullifierKeyHash[0];',
  `const recipientOwnerNullifierKeyHash        = ${config.withdrawal ? '0n' : 'outOwnerNullifierKeyHash[0]'};`);
replaceOnce('const feeNoteRecipientOwnerNullifierKeyHash = outOwnerNullifierKeyHash[2];',
  `const feeNoteRecipientOwnerNullifierKeyHash = ${config.real[2] ? 'outOwnerNullifierKeyHash[2]' : '0n'};`);
replaceOnce('const outNoteBodyCommitment = [0,1,2].map(i =>\n  poseidon(T.NOTE_BODY_COMMITMENT_DOMAIN, outOwnerCommitment[i], outAmount[i], tokenAddress));',
  'const outNoteBodyCommitment = [0,1,2].map(i =>\n  poseidon(T.NOTE_BODY_COMMITMENT_DOMAIN, outOwnerCommitment[i], outAmount[i], outIsReal[i] * tokenAddress));');
replaceOnce('const publicAmountOut         = 0n;', `const publicAmountOut         = ${config.withdrawal}n;`);
replaceOnce('const publicRecipientAddress  = 0n;',
  `const publicRecipientAddress  = ${config.withdrawal ? '0x3333333333333333333333333333333333333333n' : '0n'};`);
replaceOnce('const publicTokenAddress      = 0n;',
  `const publicTokenAddress      = ${config.withdrawal ? 'tokenAddress' : '0n'};`);
replaceOnce('  0n,                                       // operationKind = TRANSFER_OP',
  `  ${config.withdrawal ? '1n' : '0n'},`);
replaceOnce('  outAmount[0],                             // recipient amount',
  `  ${config.withdrawal ? 'publicAmountOut' : 'outAmount[0]'},`);
const generated = path.join(root, 'scripts/witness/issue10_case_generated.js');
fs.writeFileSync(generated, source);
const result = spawnSync(process.execPath, [generated], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`witness generator failed with ${result.status}`);
const input = JSON.parse(fs.readFileSync(path.join(root, 'build/pool/input.json'), 'utf8'));
const totalIn = input.inAmount.reduce((sum, amount, i) => sum + BigInt(amount) * BigInt(input.inIsReal[i]), 0n);
const totalOut = input.outAmount.reduce((sum, amount, i) => sum + BigInt(amount) * BigInt(input.outIsReal[i]), 0n);
if (totalIn !== totalOut + BigInt(input.publicAmountOut)) throw new Error('asset balance does not hold');
console.log(JSON.stringify({case: caseName, inputs: input.inAmount, outputs: input.outAmount, outputReal: input.outIsReal, publicAmountOut: input.publicAmountOut}));
