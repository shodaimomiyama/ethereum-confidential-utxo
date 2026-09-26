#!/usr/bin/env node
// Execute one proved case against a fresh Anvil chain with upstream genesis state.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [reference, rpcUrl, caseDir, deliveryPath] = process.argv.slice(2);
if (!reference || !rpcUrl || !caseDir) throw new Error('usage: receipt.mjs REFERENCE RPC_URL CASE_DIR [DELIVERY_JSON]');
const root = path.resolve(reference);
const dir = path.resolve(caseDir);
const requireUpstream = createRequire(path.join(root, 'package.json'));
const { ethers } = requireUpstream('ethers');
const { poseidon } = requireUpstream('./scripts/witness/poseidon2.js');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const artifact = (name) => read(`build/forge-out/${name}.sol/${name}.json`);
const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
const input = session.pool.witnessInput;
const tags = read('build/domain_tags.json');
const provider = new ethers.JsonRpcProvider(rpcUrl);
const rpc = (method, params) => provider.send(method, params);
const poolAddress = '0x0000000000000000000000000000000000081820';
const senderAddress = '0x1111111111111111111111111111111111111111';
const tokenAddress = '0x2222222222222222222222222222222222222222';
const authAddress = '0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1';
const recipientAddress = '0x3333333333333333333333333333333333333333';
const rows = [];
const send = async (name, response, extra = {}) => {
  const receipt = await response.wait();
  const row = {name, status: Number(receipt.status), gasUsed: receipt.gasUsed.toString(), hash: receipt.hash,
    rawReceipt: await rpc('eth_getTransactionReceipt', [receipt.hash]),
    rawTransaction: await rpc('eth_getTransactionByHash', [receipt.hash]), ...extra};
  rows.push(row);
  if (receipt.status !== 1) throw new Error(`${name} failed: ${receipt.hash}`);
  return receipt;
};
const fixed = read('assets/eip-8182/shielded-pool-state.json')[poolAddress.toLowerCase()];
await rpc('anvil_setCode', [poolAddress, fixed.code]);
for (const [slot, value] of Object.entries(fixed.storage)) await rpc('anvil_setStorageAt', [poolAddress, slot, value]);
await rpc('anvil_setCode', [tokenAddress, artifact('MockERC20').deployedBytecode.object]);
await rpc('anvil_setBalance', [senderAddress, '0x56bc75e2d63100000']);
await rpc('anvil_impersonateAccount', [senderAddress]);
const payer = await provider.getSigner(0);
const sender = await provider.getSigner(senderAddress);
const authVerifier = await new ethers.ContractFactory(artifact('AuthDemoGroth16Verifier').abi, artifact('AuthDemoGroth16Verifier').bytecode.object, payer).deploy();
await send('deploy_auth_groth16_verifier', authVerifier.deploymentTransaction());
const wrapper = await new ethers.ContractFactory(artifact('DemoAuthVerifier').abi, artifact('DemoAuthVerifier').bytecode.object, payer).deploy(await authVerifier.getAddress());
await send('deploy_demo_auth_wrapper', wrapper.deploymentTransaction());
await rpc('anvil_setCode', [authAddress, await provider.getCode(await wrapper.getAddress())]);
const pool = new ethers.Contract(poolAddress, artifact('ShieldedPool').abi, payer);
const token = new ethers.Contract(tokenAddress, artifact('MockERC20').abi, payer);
const ownerKeyHash = poseidon(BigInt(tags.OWNER_NULLIFIER_KEY_HASH_DOMAIN), BigInt(input.senderOwnerNullifierKey));
const seedHash = poseidon(BigInt(tags.NOTE_SECRET_SEED_DOMAIN), BigInt(input.senderNoteSecretSeed));
await send('set_auth_policy', await pool.connect(sender).setAuthPolicy(ownerKeyHash, seedHash, BigInt(input.policySetCommitment), {gasLimit: 10000000}));
const isEth = BigInt(input.tokenAddress) === 0n;
const amounts = input.inAmount.map(BigInt);
const realTotal = amounts.reduce((sum, amount, i) => sum + amount * BigInt(input.inIsReal[i]), 0n);
if (!isEth) await send('mint_test_token', await token.mint(await payer.getAddress(), realTotal));
for (let i = 0; i < amounts.length; i++) {
  if (input.inIsReal[i] !== '1') continue;
  const owner = poseidon(BigInt(tags.OWNER_COMMITMENT_DOMAIN), ownerKeyHash, BigInt(input.inNoteSecret[i]));
  await send(`deposit_${i}`, await pool.deposit(isEth ? ethers.ZeroAddress : tokenAddress, amounts[i], owner, '0x',
    { value: isEth ? amounts[i] : 0n, gasLimit: 10000000 }));
}
const signals = session.pool.publicSignals.map(BigInt);
const rootsBefore = await pool.getCurrentRoots();
if (rootsBefore[0] !== signals[0] || rootsBefore[1] !== signals[12]) throw new Error('witness and chain roots differ');
const ethBalance = async (address) => BigInt(await rpc('eth_getBalance', [address, 'latest']));
const assetBefore = isEth ? await ethBalance(recipientAddress) : await token.balanceOf(recipientAddress);
const payloads = deliveryPath
  ? JSON.parse(fs.readFileSync(deliveryPath, 'utf8')).outputNoteDataHex.map(hex => ethers.getBytes(hex))
  : ['eip-8182-output-0', 'eip-8182-output-1', 'eip-8182-output-2'].map(value => ethers.toUtf8Bytes(value));
const transactReceipt = await send('transact', await pool.transact(session.pool.proofHex, session.auth.proofHex, signals, ...payloads, {gasLimit: 15000000}),
  {poolProofBytes: ethers.dataLength(session.pool.proofHex), authProofBytes: ethers.dataLength(session.auth.proofHex), outputNoteDataBytes: payloads.map(value => value.length)});
const transactEvent = transactReceipt.logs.map(log => { try { return pool.interface.parseLog(log); } catch { return null; } })
  .find(event => event?.name === 'ShieldedPoolTransact');
if (!transactEvent) throw new Error('ShieldedPoolTransact event missing');
const firstInputOwner = poseidon(BigInt(tags.OWNER_COMMITMENT_DOMAIN), ownerKeyHash, BigInt(input.inNoteSecret[0]));
const firstInputBody = poseidon(BigInt(tags.NOTE_BODY_COMMITMENT_DOMAIN), firstInputOwner, amounts[0], BigInt(input.tokenAddress));
const firstSpentNoteCommitment = poseidon(BigInt(tags.NOTE_COMMITMENT_DOMAIN), firstInputBody, BigInt(input.inLeafIndex[0]));
const createdNoteCommitments = [0, 1, 2].map(i => transactEvent.args[`noteCommitment${i}`].toString());
const selfControlledOutputs = input.outIsReal.map((real, i) => real === '1' && input.outOwnerNullifierKeyHash[i] === ownerKeyHash.toString());
if (selfControlledOutputs.some((self, i) => self && createdNoteCommitments[i] === firstSpentNoteCommitment.toString())) {
  throw new Error('self output reused the original note commitment');
}
const assetAfter = isEth ? await ethBalance(recipientAddress) : await token.balanceOf(recipientAddress);
const publicAmountOut = BigInt(input.publicAmountOut);
const assetDelta = assetAfter - assetBefore;
if (assetDelta !== publicAmountOut) throw new Error(`recipient asset delta ${assetDelta} != ${publicAmountOut}`);
const rootsAfter = await pool.getCurrentRoots();
const state = {nullifier0Spent: await pool.isNullifierSpent(signals[1]), nullifier1Spent: await pool.isNullifierSpent(signals[2]),
  replayIdUsed: await pool.isIntentReplayIdUsed(signals[9]), noteRootChanged: rootsBefore[0] !== rootsAfter[0],
  recipientAssetDelta: assetDelta.toString(), poolAssetBalance: (isEth ? await ethBalance(poolAddress) : await token.balanceOf(poolAddress)).toString(),
  firstSpentNoteCommitment: firstSpentNoteCommitment.toString(), createdNoteCommitments, selfControlledOutputs};
if (!state.nullifier0Spent || !state.nullifier1Spent || !state.replayIdUsed || !state.noteRootChanged) throw new Error('post-transaction state mismatch');
const result = {source: 'local_anvil_receipt', upstreamCommit: '639baaf7b29c22eb43ba6150140902ea8dbbbc46',
  auth: 'groth16_demo', asset: isEth ? 'ETH' : 'MockERC20', inputAmounts: input.inAmount, inputIsReal: input.inIsReal, outputAmounts: input.outAmount,
  outputIsReal: input.outIsReal, publicAmountOut: input.publicAmountOut,
  delivery: deliveryPath ? path.resolve(deliveryPath) : null, receipts: rows, state};
fs.writeFileSync(path.join(dir, 'receipts.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({transactGas: rows.find(row => row.name === 'transact').gasUsed, state}));
