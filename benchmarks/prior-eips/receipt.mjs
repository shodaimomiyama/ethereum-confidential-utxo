#!/usr/bin/env node
// Run from any directory after generating upstream build/integration/session.json.
// Usage: node receipt.mjs UPSTREAM_DIR RPC_URL OUTPUT_JSON [DELIVERY_JSON]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [upstream, rpcUrl, output, deliveryPath] = process.argv.slice(2);
if (!upstream || !rpcUrl || !output) throw new Error('usage: receipt.mjs UPSTREAM_DIR RPC_URL OUTPUT_JSON [DELIVERY_JSON]');
const requireUpstream = createRequire(path.join(path.resolve(upstream), 'package.json'));
const { ethers } = requireUpstream('ethers');
const { poseidon } = requireUpstream('./scripts/witness/poseidon2.js');
const read = (name) => JSON.parse(fs.readFileSync(path.join(upstream, name), 'utf8'));
const artifact = (name) => read(`build/forge-out/${name}.sol/${name}.json`);
const provider = new ethers.JsonRpcProvider(rpcUrl);
const poolAddress = '0x0000000000000000000000000000000000081820';
const senderAddress = '0x1111111111111111111111111111111111111111';
const tokenAddress = '0x2222222222222222222222222222222222222222';
const authAddress = '0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1';
const session = read('build/integration/session.json');
const input = session.pool.witnessInput;
const tags = read('build/domain_tags.json');
const fixedState = read('assets/eip-8182/shielded-pool-state.json')[poolAddress.toLowerCase()];
const receipts = [];
const add = async (name, response, extra = {}) => {
  const receipt = await response.wait();
  const row = { name, hash: receipt.hash, status: Number(receipt.status), gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber, transaction: response.to, calldata: response.data, value: response.value?.toString() ?? '0', rawReceipt: await rpc('eth_getTransactionReceipt', [receipt.hash]), rawTransaction: await rpc('eth_getTransactionByHash', [receipt.hash]), ...extra };
  receipts.push(row);
  if (receipt.status !== 1) throw new Error(`${name} reverted: ${receipt.hash}`);
  return receipt;
};
const rpc = (method, params) => provider.send(method, params);
await rpc('anvil_setCode', [poolAddress, fixedState.code]);
for (const [slot, value] of Object.entries(fixedState.storage)) await rpc('anvil_setStorageAt', [poolAddress, slot, value]);
await rpc('anvil_setCode', [tokenAddress, artifact('MockERC20').deployedBytecode.object]);
await rpc('anvil_setBalance', [senderAddress, '0x56bc75e2d63100000']);
await rpc('anvil_impersonateAccount', [senderAddress]);
const sender = await provider.getSigner(senderAddress);
const payer = await provider.getSigner(0);
const verifierArtifact = artifact('AuthDemoGroth16Verifier');
const verifierFactory = new ethers.ContractFactory(verifierArtifact.abi, verifierArtifact.bytecode.object, payer);
const verifier = await verifierFactory.deploy();
await add('deploy_auth_groth16_verifier', verifier.deploymentTransaction());
const wrapperArtifact = artifact('DemoAuthVerifier');
const wrapperFactory = new ethers.ContractFactory(wrapperArtifact.abi, wrapperArtifact.bytecode.object, payer);
const wrapper = await wrapperFactory.deploy(await verifier.getAddress());
await add('deploy_demo_auth_wrapper', wrapper.deploymentTransaction());
await rpc('anvil_setCode', [authAddress, await provider.getCode(await wrapper.getAddress())]);

const pool = new ethers.Contract(poolAddress, artifact('ShieldedPool').abi, payer);
const token = new ethers.Contract(tokenAddress, artifact('MockERC20').abi, payer);
const onk = poseidon(BigInt(tags.OWNER_NULLIFIER_KEY_HASH_DOMAIN), BigInt(input.senderOwnerNullifierKey));
const seed = poseidon(BigInt(tags.NOTE_SECRET_SEED_DOMAIN), BigInt(input.senderNoteSecretSeed));
await add('set_auth_policy', await pool.connect(sender).setAuthPolicy(onk, seed, BigInt(input.policySetCommitment), {gasLimit: 10000000}));
const amounts = input.inAmount.map(BigInt);
await add('mint_test_token', await token.mint(await payer.getAddress(), amounts[0] + amounts[1]));
for (let i = 0; i < 2; i++) {
  const owner = poseidon(BigInt(tags.OWNER_COMMITMENT_DOMAIN), onk, BigInt(input.inNoteSecret[i]));
  await add(`deposit_${i}`, await pool.deposit(tokenAddress, amounts[i], owner, '0x', {gasLimit: 10000000}));
}
const ps = session.pool.publicSignals.map(BigInt);
const before = await pool.getCurrentRoots();
if (before[0] !== ps[0] || before[1] !== ps[12]) throw new Error('witness and chain roots differ');
const publicInputs = ps;
const ond = deliveryPath
  ? JSON.parse(fs.readFileSync(deliveryPath, 'utf8')).outputNoteDataHex.map(hex => ethers.getBytes(hex))
  : ['eip-8182-output-0', 'eip-8182-output-1', 'eip-8182-output-2'].map(value => ethers.toUtf8Bytes(value));
const tamperedInputs = [...publicInputs];
tamperedInputs[18] ^= 1n;
const tampered = await payer.sendTransaction({ to: poolAddress, data: pool.interface.encodeFunctionData('transact', [session.pool.proofHex, session.auth.proofHex, tamperedInputs, ...ond]), gasLimit: 5000000 });
let tamperedReceipt;
try { tamperedReceipt = await tampered.wait(); }
catch (error) { tamperedReceipt = error.receipt; }
receipts.push({ name: 'tampered_intent_digest', expectedStatus: 0, hash: tamperedReceipt.hash, status: Number(tamperedReceipt.status), gasUsed: tamperedReceipt.gasUsed.toString(), blockNumber: tamperedReceipt.blockNumber, rawReceipt: await rpc('eth_getTransactionReceipt', [tamperedReceipt.hash]), rawTransaction: await rpc('eth_getTransactionByHash', [tamperedReceipt.hash]) });
if (tamperedReceipt.status !== 0) throw new Error('tampered intent digest unexpectedly succeeded');
const afterRejected = await pool.getCurrentRoots();
if (afterRejected[0] !== before[0] || afterRejected[1] !== before[1] || await pool.isNullifierSpent(ps[1]) || await pool.isIntentReplayIdUsed(ps[9])) throw new Error('failed tampered transaction changed state');
await add('transact', await pool.transact(session.pool.proofHex, session.auth.proofHex, publicInputs, ...ond, {gasLimit: 15000000}), { poolProofBytes: ethers.dataLength(session.pool.proofHex), authProofBytes: ethers.dataLength(session.auth.proofHex), outputNoteDataBytes: ond.map(b => b.length) });
const after = await pool.getCurrentRoots();
const state = { nullifier0Spent: await pool.isNullifierSpent(ps[1]), nullifier1Spent: await pool.isNullifierSpent(ps[2]), replayIdUsed: await pool.isIntentReplayIdUsed(ps[9]), noteRootChanged: before[0] !== after[0] };
if (!Object.values(state).every(Boolean)) throw new Error('post-transaction state check failed');
const result = { source: 'local_anvil_receipt', upstreamCommit: '639baaf7b29c22eb43ba6150140902ea8dbbbc46', auth: 'groth16_demo', sourceSession: 'build/integration/session.json', delivery: deliveryPath ?? null, receipts, state };
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive: true});
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({transactGas: receipts.find(r => r.name === 'transact').gasUsed, output}, null, 2));
