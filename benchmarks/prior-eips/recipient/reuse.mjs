import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { testKeySeeds } from '../delivery/test-keys.mjs';

const [reference, rpcUrl, outputFile] = process.argv.slice(2);
if (!reference || !rpcUrl || !outputFile) throw new Error('usage: node reuse.mjs REF_DIR RPC_URL OUTPUT_JSON');
const ref = path.resolve(reference);
const commit = execFileSync('git', ['-C', ref, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== '639baaf7b29c22eb43ba6150140902ea8dbbbc46') throw new Error(`unexpected reference commit ${commit}`);
const root = path.resolve(path.dirname(outputFile));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n');
const upstreamRequire = createRequire(path.join(ref, 'package.json'));
const { ethers } = upstreamRequire('ethers');
const snarkjs = upstreamRequire('snarkjs');
const { proof: codec } = upstreamRequire('./src/lib');
const sdk = (name) => import(pathToFileURL(path.join(ref, 'sepolia-demo', 'dist', name)).href);
const [poseidon, { generateRecipientEncryptionKeyPair }, indexerModule] = await Promise.all([
  sdk('poseidon.js'), sdk('envelope.js'), sdk('indexer.js')
]);
const provider = new ethers.JsonRpcProvider(rpcUrl);
const poolAddress = '0x0000000000000000000000000000000000081820';
const tokenAddress = '0x2222222222222222222222222222222222222222';
const authVerifier = '0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1';
const recipientAddress = '0x3333333333333333333333333333333333333333';
const recipientOwnerNullifierKey = 0xBABE0001n;
const recipientNoteSecretSeed = 0xBABE1002n;
const recipientAuthSecret = 0xA0701338n;
const registrationBlinder = 0xCC00CC00CC00CC01n;
const blindingFactor = 0xB17ED15ABCDEF0123456789ABCDE001n;
const poolAbi = read(path.join(ref, 'build/forge-out/ShieldedPool.sol/ShieldedPool.json')).abi;
const pool = new ethers.Contract(poolAddress, poolAbi, provider);
const iface = new ethers.Interface(indexerModule.SHIELDED_POOL_EVENT_ABI);
const keyPair = generateRecipientEncryptionKeyPair({ ...testKeySeeds(0), ownerNullifierKeyHash: poseidon.ownerNullifierKeyHash(recipientOwnerNullifierKey) });
const candidates = [{ id: 'recipient-slot-0', secretKey: keyPair.secretKey }];
const indexer = new indexerModule.SepoliaDemoIndexer({ chainId: 1, poolAddress, candidates });
const logs = await provider.getLogs({ address: poolAddress, fromBlock: 0, toBlock: 'latest' });
const noteLeaves = new Map();
const authLeaves = new Map();
for (const log of logs) {
  const parsed = iface.parseLog(log);
  if (!parsed) continue;
  const args = parsed.args;
  const meta = { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.index };
  if (parsed.name === 'ShieldedPoolDeposit') {
    noteLeaves.set(Number(args.leafIndex), args.noteCommitment);
    await indexer.ingestDeposit({ ...meta, depositor: args.depositor, noteCommitment: args.noteCommitment, leafIndex: args.leafIndex, amount: args.amount, tokenAddress: args.tokenAddress, outputNoteData: args.outputNoteData });
  } else if (parsed.name === 'ShieldedPoolTransact') {
    for (let i = 0; i < 3; i++) noteLeaves.set(Number(args.leafIndex0) + i, args[`noteCommitment${i}`]);
    await indexer.ingestTransact({ ...meta, noteCommitment0: args.noteCommitment0, noteCommitment1: args.noteCommitment1, noteCommitment2: args.noteCommitment2, leafIndex0: args.leafIndex0, outputNoteData0: args.outputNoteData0, outputNoteData1: args.outputNoteData1, outputNoteData2: args.outputNoteData2 });
  } else if (parsed.name === 'AuthPolicySet') {
    authLeaves.set(args.leafPosition, args.leafValue);
  }
}
const note = indexer.store.all().find((n) => n.status === 'decrypted' && n.outputIndex === 0 && n.payload?.amount === 8n);
if (!note) throw new Error('recipient note missing from public history and decryption');
if (note.payload.ownerNullifierKeyHash !== poseidon.ownerNullifierKeyHash(recipientOwnerNullifierKey)) throw new Error('recipient owner key mismatch');
const initialRoots = await pool.getCurrentRoots();
const notePath = noteCommitmentTree(noteLeaves, 32, Number(note.leafIndex), poseidon.poseidon);
if (notePath.root !== initialRoots[0]) throw new Error('public note history did not reconstruct on-chain root');
const authPathBefore = poseidon.sparseMerkleRootAndSiblings([...authLeaves.entries()], 32, 0n);
if (authPathBefore.root !== initialRoots[1]) throw new Error('public auth history did not reconstruct on-chain root');

await provider.send('anvil_setBalance', [recipientAddress, '0x56bc75e2d63100000']);
await provider.send('anvil_impersonateAccount', [recipientAddress]);
const signer = await provider.getSigner(recipientAddress);
const ownerHash = poseidon.ownerNullifierKeyHash(recipientOwnerNullifierKey);
const seedHash = poseidon.poseidon(poseidon.NOTE_SECRET_SEED_DOMAIN, recipientNoteSecretSeed);
const authDataCommitment = poseidon.poseidon(poseidon.POLICY_COMMITMENT_DOMAIN, recipientAuthSecret);
const policy = poseidon.poseidon(poseidon.POLICY_COMMITMENT_DOMAIN, BigInt(authVerifier), authDataCommitment, registrationBlinder);
const policySet = poseidon.sparseMerkleRootAndSiblings([[0n, policy]], 8, 0n);
const registrationReceipt = await (await pool.connect(signer).setAuthPolicy(ownerHash, seedHash, policySet.root, { gasLimit: 10000000 })).wait();
if (registrationReceipt.status !== 1) throw new Error('recipient policy registration failed');
const registrationLog = registrationReceipt.logs.map((log) => { try { return iface.parseLog(log); } catch { return null; } }).find((event) => event?.name === 'AuthPolicySet');
if (!registrationLog) throw new Error('recipient registration event missing');
const leafPosition = registrationLog.args.leafPosition;
authLeaves.set(leafPosition, registrationLog.args.leafValue);
const authPath = poseidon.sparseMerkleRootAndSiblings([...authLeaves.entries()], 32, leafPosition);
const roots = await pool.getCurrentRoots();
if (authPath.root !== roots[1] || notePath.root !== roots[0]) throw new Error('post-registration roots did not reconstruct');

const nonce = 0xBABE2003n;
const replayId = poseidon.intentReplayId(recipientOwnerNullifierKey, recipientAddress, 1n, nonce);
const nullifier0 = poseidon.nullifier(note.noteCommitment, recipientOwnerNullifierKey);
const nullifier1 = poseidon.phantomNullifier(recipientOwnerNullifierKey, replayId, 1n);
const dummyOwnerHash = poseidon.dummyOwnerNullifierKeyHash();
const outputData = ['0x', '0x', '0x'];
const outputHash = outputData.map((hex) => poseidon.keccakField(ethers.getBytes(hex)));
const outputBody = outputHash.map((_, i) => {
  const secret = poseidon.transactNoteSecret(recipientNoteSecretSeed, replayId, i);
  return poseidon.noteBodyCommitment(poseidon.ownerCommitment(dummyOwnerHash, secret), 0n, 0n);
});
const blinded = poseidon.blindedAuthCommitment(authDataCommitment, blindingFactor);
const validUntilSeconds = 1735689600n;
const intentDigest = poseidon.transactionIntentDigest({
  authVerifier, authorizingAddress: recipientAddress, operationKind: 1n,
  tokenAddress: BigInt(tokenAddress), recipientOwnerNullifierKeyHash: 0n, amount: 8n,
  feeNoteRecipientOwnerNullifierKeyHash: 0n, feeAmount: 0n, publicRecipientAddress: BigInt(recipientAddress),
  executionConstraintsFlags: 0n, lockedOutputBinding0: 0n, lockedOutputBinding1: 0n, lockedOutputBinding2: 0n,
  nonce, validUntilSeconds, executionChainId: 1n
});
const input = {
  noteCommitmentRoot: roots[0], nullifier0, nullifier1,
  noteBodyCommitment0: outputBody[0], noteBodyCommitment1: outputBody[1], noteBodyCommitment2: outputBody[2],
  publicAmountOut: 8n, publicRecipientAddress: BigInt(recipientAddress), publicTokenAddress: BigInt(tokenAddress),
  intentReplayId: replayId, validUntilSeconds, executionChainId: 1n, authPolicyRoot: roots[1],
  outputNoteDataHash0: outputHash[0], outputNoteDataHash1: outputHash[1], outputNoteDataHash2: outputHash[2],
  authVerifier: BigInt(authVerifier), blindedAuthCommitment: blinded, transactionIntentDigest: intentDigest,
  senderOwnerNullifierKey: recipientOwnerNullifierKey, senderNoteSecretSeed: recipientNoteSecretSeed,
  authorizingAddress: BigInt(recipientAddress), noteSecretSeedHash: seedHash,
  policySetCommitment: policySet.root, leafPosition, authPolicySiblings: authPath.siblings,
  inIsReal: [1n, 0n], inAmount: [note.payload.amount, 0n], inNoteSecret: [note.payload.noteSecret, 0n],
  inLeafIndex: [note.leafIndex, 0n], inSiblings: [notePath.siblings, Array(32).fill(0n)],
  outIsReal: [0n, 0n, 0n], outAmount: [0n, 0n, 0n],
  outOwnerNullifierKeyHash: [dummyOwnerHash, dummyOwnerHash, dummyOwnerHash],
  outLockedOutputBinding: [0n, 0n, 0n], tokenAddress: BigInt(tokenAddress),
  recipientOwnerNullifierKeyHash: 0n, feeNoteRecipientOwnerNullifierKeyHash: 0n, feeAmount: 0n,
  nonce, executionConstraintsFlags: 0n, authDataCommitment, blindingFactor, registrationBlinder,
  policySetLeafPosition: 0n, policySetSiblings: policySet.siblings
};
const stringify = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
fs.writeFileSync(path.join(root, 'withdrawal-pool-input.json'), stringify(input) + '\n');
fs.writeFileSync(path.join(ref, 'build/pool/input.json'), stringify(input) + '\n');
const sharedIntent = {
  authVerifier: BigInt(authVerifier), authorizingAddress: BigInt(recipientAddress), operationKind: 1n,
  tokenAddress: BigInt(tokenAddress), recipientOwnerNullifierKeyHash: 0n, amount: 8n,
  feeNoteRecipientOwnerNullifierKeyHash: 0n, feeAmount: 0n, publicRecipientAddress: BigInt(recipientAddress),
  executionConstraintsFlags: 0n, lockedOutputBinding0: 0n, lockedOutputBinding1: 0n, lockedOutputBinding2: 0n,
  nonce, validUntilSeconds, executionChainId: 1n, authSecret: recipientAuthSecret, blindingFactor
};
const intentFile = path.join(root, 'withdrawal-auth-intent.json');
fs.writeFileSync(intentFile, stringify(sharedIntent) + '\n');
const witnessStart = Date.now();
execFileSync('node', ['scripts/witness/gen_auth_demo_witness_input.js', intentFile], { cwd: ref, stdio: 'pipe' });
fs.copyFileSync(path.join(ref, 'build/auth_demo/input.json'), path.join(root, 'withdrawal-auth-input.json'));
execFileSync('node', ['build/pool/pool_js/generate_witness.js', 'build/pool/pool_js/pool.wasm', 'build/pool/input.json', 'build/pool/witness.wtns'], { cwd: ref, stdio: 'pipe' });
execFileSync('node', ['build/auth_demo/auth_demo_js/generate_witness.js', 'build/auth_demo/auth_demo_js/auth_demo.wasm', 'build/auth_demo/input.json', 'build/auth_demo/witness.wtns'], { cwd: ref, stdio: 'pipe' });
const witnessGenerationMs = Date.now() - witnessStart;
const poolProveStart = Date.now();
const poolProved = await snarkjs.groth16.prove(path.join(ref, 'build/pool/pool_final.zkey'), path.join(ref, 'build/pool/witness.wtns'));
const poolProveMs = Date.now() - poolProveStart;
const authProveStart = Date.now();
const authProved = await snarkjs.groth16.prove(path.join(ref, 'build/auth_demo/auth_demo_final.zkey'), path.join(ref, 'build/auth_demo/witness.wtns'));
const authProveMs = Date.now() - authProveStart;
const verified = {
  pool: await snarkjs.groth16.verify(read(path.join(ref, 'build/pool/pool_vkey.json')), poolProved.publicSignals, poolProved.proof),
  auth: await snarkjs.groth16.verify(read(path.join(ref, 'build/auth_demo/auth_demo_vkey.json')), authProved.publicSignals, authProved.proof)
};
if (!verified.pool || !verified.auth) throw new Error(`proof verification failed ${JSON.stringify(verified)}`);
const ps = poolProved.publicSignals.map(BigInt);
if (ps[0] !== roots[0] || ps[12] !== roots[1] || ps[1] !== nullifier0 || ps[6] !== 8n) throw new Error('proof public signals mismatch');
if (BigInt(authProved.publicSignals[0]) !== ps[17] || BigInt(authProved.publicSignals[1]) !== ps[18]) throw new Error('pool and auth signals disagree');
const poolProofHex = `0x${codec.snarkjsProofToBytes(poolProved.proof).toString('hex')}`;
const authProofHex = `0x${codec.snarkjsProofToBytes(authProved.proof).toString('hex')}`;
const tokenAbi = read(path.join(ref, 'build/forge-out/MockERC20.sol/MockERC20.json')).abi;
const token = new ethers.Contract(tokenAddress, tokenAbi, provider);
const recipientBalanceBefore = await token.balanceOf(recipientAddress);
const transaction = await pool.connect(signer).transact(poolProofHex, authProofHex, ps, ...outputData, { gasLimit: 15000000 });
const receipt = await transaction.wait();
const recipientBalanceAfter = await token.balanceOf(recipientAddress);
const result = {
  schemaVersion: 1, sourceCommit: commit, operation: 'recipient-withdrawal-after-receipt',
  premise: { recipientOwnerNullifierKey: recipientOwnerNullifierKey.toString(), recipientNoteSecretSeed: recipientNoteSecretSeed.toString(), recipientAuthSecret: recipientAuthSecret.toString(), recipientAddress, encryptionKey: 'deterministic test slot 0' },
  publicHistory: { logCount: logs.length, noteLeafCount: noteLeaves.size, authLeafCountBeforeRegistration: authLeaves.size - 1, recipientLeafIndex: note.leafIndex.toString(), recipientNoteCommitment: note.noteCommitment.toString(), reconstructedNoteRoot: notePath.root.toString(), initialOnchainNoteRoot: initialRoots[0].toString(), reconstructedAuthRootBeforeRegistration: authPathBefore.root.toString(), initialOnchainAuthRoot: initialRoots[1].toString(), recipientNoteDecrypted: true },
  registration: { hash: registrationReceipt.hash, status: Number(registrationReceipt.status), gasUsed: registrationReceipt.gasUsed.toString(), rawReceipt: await provider.send('eth_getTransactionReceipt', [registrationReceipt.hash]), leafPosition: leafPosition.toString(), reconstructedAuthRoot: authPath.root.toString(), onchainAuthRoot: roots[1].toString() },
  proofs: { ...verified, witnessGenerationMs, poolProveMs, authProveMs, prover: 'snarkjs WASM', authCircuit: 'groth16_demo' },
  withdrawal: { hash: receipt.hash, status: Number(receipt.status), gasUsed: receipt.gasUsed.toString(), rawReceipt: await provider.send('eth_getTransactionReceipt', [receipt.hash]), rawTransaction: await provider.send('eth_getTransactionByHash', [receipt.hash]), nullifierSpent: await pool.isNullifierSpent(nullifier0), replayIdUsed: await pool.isIntentReplayIdUsed(replayId), recipientTokenBalanceBefore: recipientBalanceBefore.toString(), recipientTokenBalanceAfter: recipientBalanceAfter.toString() }
};
write(outputFile, result);
console.log(JSON.stringify({ hash: receipt.hash, status: result.withdrawal.status, received: (recipientBalanceAfter - recipientBalanceBefore).toString() }));
if (receipt.status !== 1 || recipientBalanceAfter - recipientBalanceBefore !== 8n || !result.withdrawal.nullifierSpent || !result.withdrawal.replayIdUsed) process.exitCode = 2;
provider.destroy();
process.exit(process.exitCode ?? 0);

function noteCommitmentTree(leaves, depth, queryIndex, hash) {
  const empty = [0n];
  for (let i = 0; i < depth; i++) empty.push(hash(empty[i], empty[i]));
  let level = new Map(leaves);
  let pos = queryIndex;
  const siblings = [];
  for (let i = 0; i < depth; i++) {
    siblings.push(level.get(pos ^ 1) ?? empty[i]);
    const next = new Map();
    for (const [index] of level) {
      const left = (index & 1) ? level.get(index ^ 1) ?? empty[i] : level.get(index);
      const right = (index & 1) ? level.get(index) : level.get(index ^ 1) ?? empty[i];
      next.set(index >> 1, hash(left, right));
    }
    level = next;
    pos >>= 1;
  }
  return { root: level.get(0) ?? empty[depth], siblings };
}
