#!/usr/bin/env node
// Recompute the supplemental case table directly from preserved receipts.
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const raw = path.join(root, 'raw');
const names = fs.readdirSync(raw).filter(name => fs.existsSync(path.join(raw, name, 'status.json'))).sort();
const rows = names.map(name => {
  const dir = path.join(raw, name);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  if (status.status !== 'passed') return {name, status: status.status, evidence: status.evidence};
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'receipts.json'), 'utf8'));
  const input = JSON.parse(fs.readFileSync(path.join(dir, 'pool-input.json'), 'utf8'));
  const inputIsReal = record.inputIsReal ?? input.inIsReal;
  const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timings.json'), 'utf8'));
  const receipt = operation => record.receipts.find(row => row.name === operation);
  const deposits = record.receipts.filter(row => row.name.startsWith('deposit_'));
  const realInputCount = inputIsReal.filter(value => value === '1').length;
  const realOutputCount = record.outputIsReal.filter(value => value === '1').length;
  const inputTotal = record.inputAmounts.reduce((sum, amount, index) => sum + BigInt(amount) * BigInt(inputIsReal[index]), 0n);
  const outputTotal = record.outputAmounts.reduce((sum, amount, index) => sum + BigInt(amount) * BigInt(record.outputIsReal[index]), 0n);
  if (inputTotal !== outputTotal + BigInt(record.publicAmountOut)) throw new Error(`${name}: amount conservation failed`);
  if (deposits.length !== realInputCount) throw new Error(`${name}: deposit count does not match real inputs`);
  if (record.receipts.some(row => row.status !== 1) || !Object.entries(record.state).filter(([key]) => key.endsWith('Spent') || key === 'replayIdUsed' || key === 'noteRootChanged').every(([,value]) => value === true)) {
    throw new Error(`${name}: transaction or state check failed`);
  }
  return {
    name, status: 'passed', asset: record.asset,
    inputs: record.inputAmounts, inputIsReal, realInputCount,
    outputs: record.outputAmounts, outputIsReal: record.outputIsReal, realOutputCount,
    publicAmountOut: record.publicAmountOut,
    depositGas: deposits.map(row => row.gasUsed),
    policyRegistrationGas: receipt('set_auth_policy').gasUsed,
    verifierDeploymentGas: receipt('deploy_auth_groth16_verifier').gasUsed,
    authWrapperDeploymentGas: receipt('deploy_demo_auth_wrapper').gasUsed,
    tokenMintGas: receipt('mint_test_token')?.gasUsed ?? null,
    transactGas: receipt('transact').gasUsed,
    poolProveMs: timing.poolProveMs, authProveMs: timing.authProveMs,
    recipientPublicAssetDelta: record.state.recipientAssetDelta,
    finalPoolAssetBalance: record.state.poolAssetBalance,
    firstSpentNoteCommitment: record.state.firstSpentNoteCommitment ?? null,
    createdNoteCommitments: record.state.createdNoteCommitments ?? null,
    selfControlledOutputs: record.state.selfControlledOutputs ?? null,
    receiptPath: `raw/${name}/receipts.json`, proofPath: `raw/${name}/session.json`,
  };
});
const result = {source: 'case raw receipts and proof timings', runsPerCase: 1, successful: rows.filter(row => row.status === 'passed').length, cases: rows};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({successful: result.successful, total: rows.length, output: path.join(root, 'summary.json')}));
