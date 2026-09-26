const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const dependency = createRequire(path.join(__dirname, '../bulletproof/package.json'));
const solc = dependency('solc');
const { ContractFactory, JsonRpcProvider, keccak256, toUtf8Bytes, toBeHex, concat } = dependency('ethers');
assert(solc.version().startsWith('0.4.19+commit.c4cbbb05'), 'Compiler version differs from the experiment');
assert.equal(dependency('ethers').version, '6.13.4');

const root = __dirname;
const output = path.resolve(root, process.env.EXPERIMENT_OUTPUT || '.cache/reproduction');
const profile = readJson(path.join(root, 'profile.json'));
const fixedParameters = readJson(path.join(root, 'parameters.json'));
const q = BigInt(profile.scalarModulus);
const p = BigInt(profile.coordinateModulus);
const maximumGas = 29000000n;
const tags = Object.fromEntries(Object.entries(profile.tags).map(([key, value]) => [key, keccak256(toUtf8Bytes(value))]));
const word = value => toBeHex(BigInt(value), 32);
const hashWords = words => keccak256(concat(words));

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)}\n`);
}

function validateParameters(parameters) {
  assert.deepEqual(parameters.base, fixedParameters.base);
  assert.deepEqual(parameters.gs, fixedParameters.gs);
  assert.deepEqual(parameters.hs, fixedParameters.hs);
  const points = [];
  for (let i = 0; i < 4; i += 2) points.push(parameters.base.slice(i, i + 2));
  for (const vector of [parameters.gs, parameters.hs]) {
    assert.equal(vector.length, 128);
    for (let i = 0; i < 64; i++) points.push([vector[i], vector[i + 64]]);
  }
  const unique = new Set();
  for (const [xs, ys] of points) {
    const x = BigInt(xs), y = BigInt(ys);
    assert(x >= 0n && x < p && y >= 0n && y < p);
    assert(x !== 0n || y !== 0n);
    assert.equal(y * y % p, (x * x % p * x + 3n) % p);
    assert(!unique.has(`${x},${y}`));
    unique.add(`${x},${y}`);
  }
  const digest = hashWords([tags.parameters, word(64), ...points.flat().map(word)]);
  assert.equal(digest, profile.expectedParametersHash);
  return { pointsValidated: points.length, pairwiseDistinct: true, parametersHash: digest };
}

function challengeStep(state, stage, payload) {
  const inputState = hashWords([state, tags[stage], payload]);
  for (let counter = 0; counter < 256; counter++) {
    const candidate = BigInt(hashWords([inputState, tags.candidate, word(counter)]));
    if (candidate > 0n && candidate < q) {
      return { inputState, challenge: candidate, counter, nextState: hashWords([inputState, tags.accepted, word(candidate)]) };
    }
  }
  throw new Error('Challenge rejection limit reached');
}

function compileContracts() {
  const sources = {}, sourceHashes = {};
  for (const filename of fs.readdirSync(path.join(root, 'solidity')).filter(name => name.endsWith('.sol'))) {
    sources[filename] = { content: fs.readFileSync(path.join(root, 'solidity', filename), 'utf8') };
  }
  sources['VerificationHarness.sol'] = { content: fs.readFileSync(path.join(root, 'VerificationHarness.sol'), 'utf8') };
  for (const [name, source] of Object.entries(sources)) sourceHashes[name] = crypto.createHash('sha256').update(source.content).digest('hex');
  const compiled = JSON.parse(solc.compileStandardWrapper(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  })));
  writeJson(path.join(output, 'compiler-diagnostics.json'), compiled.errors || []);
  assert.equal((compiled.errors || []).filter(error => error.severity === 'error').length, 0, 'Solidity compilation failed');
  writeJson(path.join(output, 'compiled-contracts.json'), compiled.contracts);
  return { compiled, sourceHashes };
}

async function awaitReceipt(provider, transactionHash, expectedStatus = 1n) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await provider.send('eth_getTransactionReceipt', [transactionHash]);
    if (receipt) {
      assert.equal(BigInt(receipt.status), expectedStatus);
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Receipt deadline: ${transactionHash}`);
}

async function deploy(compiled, signer, name, arguments_) {
  const artifact = compiled.contracts[`${name}.sol`][name];
  assert(artifact.evm.deployedBytecode.object.length / 2 <= 24576, 'EIP-170 code size exceeded');
  const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
  const contract = await factory.deploy(...arguments_, { gasLimit: maximumGas });
  const receipt = await awaitReceipt(signer.provider, contract.deploymentTransaction().hash);
  const runtime = await signer.provider.send('eth_getCode', [await contract.getAddress(), 'latest']);
  assert.notEqual(runtime, '0x');
  return { contract, measurement: { address: await contract.getAddress(), gasUsed: BigInt(receipt.gasUsed), runtimeCodeBytes: runtime.length / 2 - 1, runtimeCodeKeccak256: keccak256(runtime), initCodeBytes: artifact.evm.bytecode.object.length / 2 } };
}

function mutate(proof, label, change) {
  const result = structuredClone(Object.fromEntries(['operationId', 'outputIndex', 'coords', 'scalars', 'ls', 'rs'].map(key => [key, proof[key]])));
  result.label = label;
  result.expectedValid = false;
  delete result.javaVerifierAccepted;
  delete result.javaVerifierRejection;
  result.javaVerificationScope = 'Mutation constructed by JavaScript and submitted to EVM only';
  change(result);
  return result;
}

async function classifyRevert(provider, call) {
  const trace = await provider.send('debug_traceCall', [{ ...call, gas: toBeHex(maximumGas) }, 'latest', { disableStorage: true, disableMemory: true, disableStack: true }]);
  const last = trace.structLogs.at(-1);
  const errors = trace.structLogs.filter(step => step.error).map(step => step.error);
  assert(trace.failed && last?.op === 'REVERT' && BigInt(last.gas) > 0n && errors.length === 0, 'Resource failure or unclassified execution failure cannot establish expected rejection');
  return { classification: 'Explicit REVERT with gas remaining and no trace step error', lastOpcode: last.op, gasRemaining: last.gas, gasUsed: trace.gas, traceErrors: errors };
}

function negativeCases(proof) {
  const cases = [];
  for (let i = 0; i < 5; i++) {
    cases.push(mutate(proof, `scalar-${i}-plus-q`, item => { item.scalars[i] = (BigInt(item.scalars[i]) + q).toString(); }));
    cases.push(mutate(proof, `scalar-${i}-equals-q`, item => { item.scalars[i] = q.toString(); }));
  }
  cases.push(mutate(proof, 'changed-tauX', item => { item.scalars[0] = ((BigInt(item.scalars[0]) + 1n) % q).toString(); }));
  cases.push(mutate(proof, 'changed-operation-id', item => { item.operationId = word(BigInt(item.operationId) ^ 1n); }));
  cases.push(mutate(proof, 'changed-output-index', item => { item.outputIndex = (BigInt(item.outputIndex) + 1n).toString(); }));
  cases.push(mutate(proof, 'different-valid-commitment', item => { item.coords[0] = '1'; item.coords[1] = '2'; }));
  cases.push(mutate(proof, 'commitment-coordinate-equals-p', item => { item.coords[0] = p.toString(); }));
  cases.push(mutate(proof, 'commitment-off-curve', item => { item.coords[0] = '1'; item.coords[1] = '1'; }));
  for (let index = 2; index < 10; index += 2) {
    cases.push(mutate(proof, `internal-point-${index / 2}-identity`, item => { item.coords[index] = '0'; item.coords[index + 1] = '0'; }));
  }
  for (const name of ['ls', 'rs']) {
    cases.push(mutate(proof, `${name}-missing-coordinate`, item => { item[name].pop(); }));
    cases.push(mutate(proof, `${name}-extra-coordinate`, item => { item[name].push('0'); }));
    cases.push(mutate(proof, `${name}-noncanonical-coordinate`, item => { item[name][0] = p.toString(); }));
    cases.push(mutate(proof, `${name}-off-curve`, item => { item[name][0] = '1'; item[name][6] = '1'; }));
    for (let i = 0; i < 6; i++) cases.push(mutate(proof, `${name}-round-${i}-identity`, item => { item[name][i] = '0'; item[name][i + 6] = '0'; }));
  }
  return cases;
}

async function evaluateProof(verifier, harness, signer, proof) {
  if (proof.proverError) {
    assert.equal(proof.expectedValid, false, 'A normal case failed to generate');
    return { label: proof.label, expectedValid: false, submitted: false, proverError: proof.proverError, matchesExpectation: true };
  }
  const arguments_ = [proof.operationId, proof.outputIndex, proof.coords, proof.scalars, proof.ls, proof.rs];
  const calldata = verifier.interface.encodeFunctionData('verify', arguments_);
  const observation = { label: proof.label, expectedValid: proof.expectedValid, submitted: true, calldata, calldataBytes: calldata.length / 2 - 1 };
  const started = performance.now();
  try {
    observation.accepted = await verifier.verify.staticCall(...arguments_, { gasLimit: maximumGas });
    observation.returnedNormally = true;
  } catch (error) {
    if (error.code !== 'CALL_EXCEPTION') throw error;
    observation.accepted = false;
    observation.returnedNormally = false;
    observation.error = error.shortMessage || error.message;
    observation.errorData = error.data;
    observation.rejectionTrace = await classifyRevert(signer.provider, { to: await verifier.getAddress(), data: calldata });
  }
  observation.callMilliseconds = performance.now() - started;
  if (observation.accepted || proof.label === 'changed-tauX') {
    const transaction = await signer.sendTransaction({ to: await harness.getAddress(), data: calldata, gasLimit: maximumGas });
    const receipt = await awaitReceipt(signer.provider, transaction.hash, observation.accepted ? 1n : 0n);
    observation.harness = { status: Number(BigInt(receipt.status)), gasUsed: BigInt(receipt.gasUsed), transactionHash: transaction.hash, assertion: 'STATICCALL success, 32 bytes returndata and uint256 result 1' };
  }
  observation.matchesExpectation = observation.accepted === proof.expectedValid;
  if (proof.javaVerifierAccepted !== undefined) {
    assert.equal(proof.javaVerifierAccepted, proof.expectedValid, 'Java verdict disagreed with case expectation');
    assert.equal(proof.javaVerifierAccepted, observation.accepted, 'Java and EVM verdicts disagreed');
  }
  console.log(`${proof.label}: expected=${proof.expectedValid}, accepted=${observation.accepted}, normalReturn=${observation.returnedNormally}`);
  return observation;
}

async function checkTrace(proof, helper) {
  let state = hashWords([tags.protocol, word(64), word(1), profile.expectedParametersHash, proof.operationId, tags.role, word(proof.outputIndex), ...proof.coords.slice(0, 2).map(word)]);
  assert.equal(state, proof.transcriptTrace.initialState);
  assert.equal(await helper.initialState.staticCall(proof.operationId, proof.outputIndex, ...proof.coords.slice(0, 2)), state);
  const observations = [];
  for (const entry of proof.transcriptTrace.stages) {
    assert.equal(entry.previousState, state);
    if (entry.stage === 'inner') {
      assert.equal(entry.payloadHex, concat([word(64), ...entry.P.map(word), ...entry.uPoint.map(word)]));
      const onchain = await helper.innerState.staticCall(state, [...entry.P, ...entry.uPoint]);
      state = hashWords([state, tags.inner, entry.payloadHex]);
      assert.equal(entry.nextState, state);
      assert.equal(onchain, state);
      observations.push({ stage: 'inner', state, matched: true });
      continue;
    }
    const expectedPayload = entry.stage === 'y' ? concat(proof.coords.slice(2, 6).map(word))
      : entry.stage === 'z' ? '0x'
      : entry.stage === 'x' ? concat(proof.coords.slice(6, 10).map(word))
      : entry.stage === 'u' ? concat(proof.scalars.slice(0, 3).map(word))
      : concat([word(entry.roundIndex), word(proof.ls[entry.roundIndex]), word(proof.ls[entry.roundIndex + 6]), word(proof.rs[entry.roundIndex]), word(proof.rs[entry.roundIndex + 6])]);
    assert.equal(entry.payloadHex, expectedPayload);
    const calculated = challengeStep(state, entry.stage, entry.payloadHex);
    assert.equal(calculated.inputState, entry.inputState);
    assert.equal(calculated.challenge.toString(), entry.challenge);
    assert.equal(calculated.counter, Number(entry.counter));
    assert.equal(calculated.nextState, entry.nextState);
    const onchain = await helper.challengeStep.staticCall(state, tags[entry.stage], entry.payloadHex);
    assert.equal(onchain[0], calculated.nextState);
    assert.equal(onchain[1], calculated.challenge);
    assert.equal(onchain[2], BigInt(calculated.counter));
    state = calculated.nextState;
    observations.push({ stage: entry.stage, counter: calculated.counter, matched: true });
  }
  assert.equal(observations.length, 11);
  assert.equal(state, proof.transcriptTrace.finalState);
  return { label: proof.label, initialState: proof.transcriptTrace.initialState, stages: observations, matched: true };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const inputs = readJson(path.join(output, 'java-64.json'));
  assert.equal(inputs.allExpectedJavaOutcomesSatisfied, true);
  const compilation = compileContracts();
  const run = { compiler: solc.version(), optimizer: { enabled: true, runs: 200 }, hardfork: 'prague', sourceHashes: compilation.sourceHashes, parameters: validateParameters(inputs.parameters), deployments: {}, observations: [], transcriptChecks: [], boundaryChecks: [], constructorChecks: [] };
  const log = fs.openSync(path.join(output, 'anvil.log'), 'w');
  const node = spawn('anvil', ['--host', '127.0.0.1', '--port', '18548', '--hardfork', 'prague', '--chain-id', '31337', '--gas-limit', '30000000', '--quiet'], { stdio: ['ignore', log, log] });
  const provider = new JsonRpcProvider('http://127.0.0.1:18548', 31337, { staticNetwork: true });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (node.exitCode !== null) throw new Error(`Anvil exited with ${node.exitCode}`);
      try { await provider.send('eth_chainId', []); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(ready, 'Anvil startup failed');
    const signer = await provider.getSigner(0);
    const range = await deploy(compilation.compiled, signer, 'RangeProofVerifier', [inputs.parameters.base, inputs.parameters.gs, inputs.parameters.hs]);
    const harness = await deploy(compilation.compiled, signer, 'VerificationHarness', [range.measurement.address]);
    const helper = await deploy(compilation.compiled, signer, 'VerifierTestHelper', []);
    run.deployments = { rangeProof: range.measurement, verificationHarness: harness.measurement, boundaryHarness: helper.measurement };
    for (const candidate of [0n, 1n, q - 1n, q, (1n << 256n) - 1n]) {
      const allowed = await helper.contract.candidateAllowed.staticCall(candidate);
      assert.equal(allowed, candidate > 0n && candidate < q);
      const scalarAllowed = await helper.contract.scalarAllowed.staticCall(candidate);
      assert.equal(scalarAllowed, candidate < q);
      run.boundaryChecks.push({ candidate, allowed, scalarAllowed, scope: 'Production acceptance predicate, not a Keccak preimage' });
    }
    assert.equal(await helper.contract.negateScalar.staticCall(0), 0n);
    assert.equal(await helper.contract.negateScalar.staticCall(1), q - 1n);
    let zeroInverseRejected = false;
    try { await helper.contract.invertScalar.staticCall(0); }
    catch (error) { if (error.code !== 'CALL_EXCEPTION') throw error; zeroInverseRejected = true; }
    assert(zeroInverseRejected);
    run.boundaryChecks.push({ negationZeroIsCanonical: true, zeroInverseRejected });
    for (const [x, y, allowIdentity, expected] of [[0n,0n,true,true],[0n,0n,false,false],[1n,2n,false,true],[1n,1n,true,false],[p,2n,true,false]]) {
      const accepted = await helper.contract.pointAllowed.staticCall(x, y, allowIdentity);
      assert.equal(accepted, expected);
      run.boundaryChecks.push({ point: [x,y], allowIdentity, accepted });
    }
    const validProof = inputs.proofs.find(item => item.expectedValid && !item.proverError);
    assert(validProof);
    const allProofs = [...inputs.proofs, ...negativeCases(validProof)];
    writeJson(path.join(output, 'submitted-inputs.json'), allProofs);
    for (const proof of allProofs) {
      run.observations.push(await evaluateProof(range.contract, harness.contract, signer, proof));
      writeJson(path.join(output, 'evm-64.json'), run);
    }
    for (const proof of inputs.proofs.filter(item => item.expectedValid && !item.proverError)) run.transcriptChecks.push(await checkTrace(proof, helper.contract));
    const artifact = compilation.compiled.contracts['RangeProofVerifier.sol'].RangeProofVerifier;
    const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
    for (const [label, replace] of [
      ['different-valid-generator', vector => { vector[0] = '1'; vector[64] = '2'; }],
      ['duplicate-generator', vector => { vector[0] = vector[1]; vector[64] = vector[65]; }],
      ['identity-generator', vector => { vector[0] = '0'; vector[64] = '0'; }],
    ]) {
      const changed = structuredClone(inputs.parameters.gs);
      replace(changed);
      const transaction = await factory.getDeployTransaction(inputs.parameters.base, changed, inputs.parameters.hs);
      let rejected = false;
      try { await provider.call({ ...transaction, gasLimit: maximumGas }); }
      catch (error) { if (error.code !== 'CALL_EXCEPTION') throw error; await classifyRevert(provider, { data: transaction.data }); rejected = true; }
      assert(rejected, label);
      run.constructorChecks.push({ label, rejected });
    }
    run.succeeded = run.observations.every(item => item.matchesExpectation) && run.transcriptChecks.every(item => item.matched);
    writeJson(path.join(output, 'evm-64.json'), run);
    assert(run.succeeded, 'At least one case disagreed with the fixed profile');
    console.log(JSON.stringify({ succeeded: run.succeeded, proofs: run.observations.length, transcriptChecks: run.transcriptChecks.length, constructorChecks: run.constructorChecks.length }));
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    fs.closeSync(log);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
