#!/usr/bin/env node
// Prove the current build/pool/input.json with the upstream pool and demo auth keys.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const [reference, outputDir] = process.argv.slice(2);
if (!reference || !outputDir) throw new Error('usage: prove.mjs REFERENCE OUTPUT_DIR');
const root = path.resolve(reference);
const out = path.resolve(outputDir);
fs.mkdirSync(out, { recursive: true });
const requireUpstream = createRequire(path.join(root, 'package.json'));
const snarkjs = requireUpstream('snarkjs');
const codec = requireUpstream('./src/lib').proof;
const run = (args) => {
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (child.status !== 0) throw new Error(`${args.join(' ')} failed: ${child.status}`);
};
const input = JSON.parse(fs.readFileSync(path.join(root, 'build/pool/input.json'), 'utf8'));
const operationKind = BigInt(input.publicAmountOut) === 0n ? '0' : '1';
const sharedIntent = {
  authVerifier: input.authVerifier,
  authorizingAddress: input.authorizingAddress,
  operationKind,
  tokenAddress: input.tokenAddress,
  recipientOwnerNullifierKeyHash: input.recipientOwnerNullifierKeyHash,
  amount: operationKind === '0' ? input.outAmount[0] : input.publicAmountOut,
  feeNoteRecipientOwnerNullifierKeyHash: input.feeNoteRecipientOwnerNullifierKeyHash,
  feeAmount: input.feeAmount,
  publicRecipientAddress: input.publicRecipientAddress,
  executionConstraintsFlags: input.executionConstraintsFlags,
  lockedOutputBinding0: input.outLockedOutputBinding[0],
  lockedOutputBinding1: input.outLockedOutputBinding[1],
  lockedOutputBinding2: input.outLockedOutputBinding[2],
  nonce: input.nonce,
  validUntilSeconds: input.validUntilSeconds,
  executionChainId: input.executionChainId,
  authSecret: '0xA0701337',
  blindingFactor: '0xB17ED15ABCDEF0123456789ABCDEF01',
};
const intentPath = path.join(root, 'build/auth_demo/issue10_shared_intent.json');
fs.writeFileSync(intentPath, JSON.stringify(sharedIntent, null, 2));
run(['scripts/witness/gen_auth_demo_witness_input.js', intentPath]);
const authInput = JSON.parse(fs.readFileSync(path.join(root, 'build/auth_demo/input.json'), 'utf8'));
if (authInput.transactionIntentDigest !== input.transactionIntentDigest ||
    authInput.blindedAuthCommitment !== input.blindedAuthCommitment) {
  throw new Error('pool and auth public inputs disagree');
}
for (const [circuit, dir] of [['pool', 'pool'], ['auth_demo', 'auth_demo']]) {
  run([`build/${dir}/${circuit}_js/generate_witness.js`, `build/${dir}/${circuit}_js/${circuit}.wasm`, `build/${dir}/input.json`, `build/${dir}/witness.wtns`]);
}
const prove = async (dir) => {
  const start = performance.now();
  const result = await snarkjs.groth16.prove(path.join(root, `build/${dir}/${dir}_final.zkey`), path.join(root, `build/${dir}/witness.wtns`));
  const elapsedMs = performance.now() - start;
  const vk = JSON.parse(fs.readFileSync(path.join(root, `build/${dir}/${dir}_vkey.json`), 'utf8'));
  if (!await snarkjs.groth16.verify(vk, result.publicSignals, result.proof)) throw new Error(`${dir} local verification failed`);
  return { ...result, elapsedMs, proofHex: '0x' + codec.snarkjsProofToBytes(result.proof).toString('hex') };
};
const pool = await prove('pool');
const auth = await prove('auth_demo');
const session = {
  pool: { proofHex: pool.proofHex, publicSignals: pool.publicSignals, witnessInput: input },
  auth: { proofHex: auth.proofHex, publicSignals: auth.publicSignals },
};
fs.writeFileSync(path.join(out, 'session.json'), JSON.stringify(session, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'timings.json'), JSON.stringify({poolProveMs: pool.elapsedMs, authProveMs: auth.elapsedMs, prover: 'snarkjs WASM', auth: 'Groth16 demo', localVerify: true}, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'pool-input.json'), JSON.stringify(input, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'auth-input.json'), JSON.stringify(authInput, null, 2) + '\n');
console.log(JSON.stringify({poolProveMs: pool.elapsedMs, authProveMs: auth.elapsedMs, localVerify: true}));
process.exit(0);
