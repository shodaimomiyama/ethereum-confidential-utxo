import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import {
  P, Q, balanceWitness, commit, computeBalancePoint, generateBalanceProof, generateRangeProof,
} from '../packages/crypto/dist/index.js';
import { buildRangeBody } from '../packages/crypto/dist/range/body.js';
import { finishRangeBody } from '../packages/crypto/dist/range/fold.js';

const artifactPath = process.argv[2];
if (!artifactPath) throw new Error('usage: pnpm interop:crypto PATH_TO_VERIFIER_V3_ARTIFACT');
const artifact = JSON.parse(readFileSync(resolve(artifactPath), 'utf8'));
const parameters = JSON.parse(readFileSync('experiments/design/crypto-profile-v3/exp08/parameters.json', 'utf8'));
const sha256Hex = (hex) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
if (sha256Hex(artifact.creationBytecode) !== artifact.manifest.creationSha256 ||
    sha256Hex(artifact.runtimeBytecode) !== artifact.manifest.runtimeSha256 ||
    artifact.parametersHash !== parameters.expectedParametersHash) {
  throw new Error('verifier artifact manifest or fixed parameters mismatch');
}

const host = '127.0.0.1';
const port = 18553;
const url = `http://${host}:${port}`;
const portInUse = () => new Promise((done) => {
  const socket = connect({ host, port });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
  socket.setTimeout(500, () => { socket.destroy(); done(false); });
});
if (await portInUse()) throw new Error(`port ${port} is already in use`);

const anvil = spawn('anvil', [
  '--silent', '--host', host, '--port', String(port), '--hardfork', 'cancun',
  '--chain-id', '31337', '--gas-limit', '30000000',
], { stdio: 'ignore' });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (anvil.exitCode !== null) throw new Error('Anvil exited during startup');
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(500),
      });
      if ((await response.json()).result === '0x7a69') { ready = true; break; }
    } catch { /* Anvil is still starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error('Anvil did not start');

  const publicClient = createPublicClient({ transport: http(url) });
  const unlocked = createWalletClient({ transport: http(url) });
  const accounts = await unlocked.getAddresses();
  const caller = accounts[0];
  const otherCaller = accounts[1];
  if (!caller || !otherCaller) throw new Error('Anvil accounts unavailable');
  const wallet = createWalletClient({ account: caller, transport: http(url) });
  const hash = await wallet.deployContract({
    abi: artifact.abi, bytecode: artifact.creationBytecode,
    args: [parameters.base.map(BigInt), parameters.gs.map(BigInt), parameters.hs.map(BigInt)],
    chain: null, gas: 29_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('verifier deployment failed');
  const address = receipt.contractAddress;
  const runtime = await publicClient.getCode({ address });
  if (!runtime || sha256Hex(runtime) !== artifact.manifest.runtimeSha256) {
    throw new Error('deployed verifier runtime mismatch');
  }

  const operationId = `0x${'66'.repeat(32)}`;
  const changedOperationId = `0x${'77'.repeat(32)}`;
  const operationBytes = Uint8Array.from(Buffer.from(operationId.slice(2), 'hex'));
  const verifyRange = async (proof, op = operationId, index = 0n, coords = proof.coords) =>
    publicClient.readContract({
      address, abi: artifact.abi, functionName: 'verify',
      args: [op, index, coords, proof.scalars, proof.ls, proof.rs],
      gas: 29_000_000n,
    });
  const rejected = async (call) => {
    try { return !await call(); }
    catch { return true; }
  };
  let rangesAccepted = 0;
  for (const opening of [
    { amount: 1n, blinding: 0n },
    { amount: 1n << 64n, blinding: 42n },
  ]) {
    const proof = generateRangeProof(opening, operationBytes, 0n);
    if (!await verifyRange(proof)) throw new Error('TS range proof rejected');
    if (await verifyRange(proof, changedOperationId)) throw new Error('operation mutation accepted');
    if (await verifyRange(proof, operationId, 1n)) throw new Error('output-index mutation accepted');
    if (opening.amount === 1n) {
      const changed = [...proof.coords];
      const h = commit({ amount: 1n, blinding: 0n });
      changed[0] = h.x; changed[1] = h.y;
      if (await verifyRange(proof, operationId, 0n, changed)) throw new Error('range commitment mutation accepted');
      const invalidPoint = [...proof.coords];
      invalidPoint[2] = P;
      if (!await rejected(() => verifyRange(proof, operationId, 0n, invalidPoint))) {
        throw new Error('noncanonical range point accepted');
      }
      const invalidScalar = { ...proof, scalars: [Q, ...proof.scalars.slice(1)] };
      if (!await rejected(() => verifyRange(invalidScalar))) throw new Error('noncanonical range scalar accepted');
      const shortRounds = { ...proof, ls: proof.ls.slice(0, -1) };
      if (!await rejected(() => verifyRange(shortRounds))) throw new Error('short range rounds accepted');
    }
    rangesAccepted++;
  }
  const identityBody = buildRangeBody(
    { amount: 1n, blinding: 0n }, operationBytes, 0n, { next: () => 0n },
  );
  const identityRange = finishRangeBody(identityBody);
  if (identityRange.coords.slice(4, 10).some((value) => value !== 0n) ||
      !await verifyRange(identityRange)) {
    throw new Error('valid range proof with internal identity points rejected');
  }
  rangesAccepted++;

  const inputOpening = { amount: 7n, blinding: 9n };
  const outputOpening = { amount: 7n, blinding: 4n };
  const X = computeBalancePoint([commit(inputOpening)], [commit(outputOpening)], 0n, 0n);
  const x = balanceWitness([inputOpening.blinding], [outputOpening.blinding]);
  const pool = Uint8Array.from(Buffer.from(caller.slice(2), 'hex'));
  const makeBalance = (chainId) => generateBalanceProof({ X, x, chainId, pool, operationId: operationBytes });
  const proof = makeBalance(31337n);
  const verifyBalance = async (balance, op = operationId, balancePoint = X, account = caller) =>
    publicClient.readContract({
      address, abi: artifact.abi, functionName: 'verifyBalance', account,
      args: [op, balancePoint.x, balancePoint.y, balance.Rx, balance.Ry, balance.s],
    });
  if (!await verifyBalance(proof)) throw new Error('TS balance proof rejected');
  if (await verifyBalance(proof, changedOperationId)) throw new Error('balance operation mutation accepted');
  if (await verifyBalance(proof, operationId, { x: 0n, y: 0n })) throw new Error('balance point mutation accepted');
  if (await verifyBalance(makeBalance(31338n))) throw new Error('chain mutation accepted');
  if (await verifyBalance(proof, operationId, X, otherCaller)) throw new Error('pool mutation accepted');
  if (!await rejected(() => verifyBalance({ ...proof, Rx: 0n, Ry: 0n }))) {
    throw new Error('identity balance nonce point accepted');
  }
  if (!await rejected(() => verifyBalance({ ...proof, s: Q }))) {
    throw new Error('noncanonical balance scalar accepted');
  }
  if (!await rejected(() => verifyBalance({ ...proof, s: 0n }))) {
    throw new Error('invalid zero balance response accepted');
  }
  const identity = { x: 0n, y: 0n };
  const identityProof = generateBalanceProof({ X: identity, x: 0n, chainId: 31337n, pool, operationId: operationBytes });
  if (!await verifyBalance(identityProof, operationId, identity)) throw new Error('identity balance proof rejected');

  console.log(JSON.stringify({
    artifactSha256: createHash('sha256').update(readFileSync(resolve(artifactPath))).digest('hex'),
    runtimeSha256: artifact.manifest.runtimeSha256,
    rangesAccepted, identityRangeAccepted: true, balanceAccepted: true, identityBalanceAccepted: true,
    mutationChecks: ['range.operationId', 'range.outputIndex', 'range.C_range',
      'range.point', 'range.scalar', 'range.roundLength',
      'balance.operationId', 'balance.X', 'balance.chainId', 'balance.pool',
      'balance.R_identity', 'balance.scalar', 'balance.s_zero_invalid'],
  }));
} finally {
  anvil.kill('SIGTERM');
}
