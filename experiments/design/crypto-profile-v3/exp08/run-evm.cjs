const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const load = createRequire(path.resolve(__dirname, '../../bulletproof/package.json'));
const solc = load('solc');
const { ContractFactory, JsonRpcProvider, keccak256, toUtf8Bytes, toBeHex, concat } = load('ethers');
const root = __dirname;
const cache = path.join(root, '.cache');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const save = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');

async function receipt(provider, hash) {
  for (let i = 0; i < 100; i++) {
    const found = await provider.send('eth_getTransactionReceipt', [hash]);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Transaction receipt unavailable');
}

async function main() {
  assert(solc.version().startsWith('0.4.19+commit.c4cbbb05'));
  const names = ['alt_bn128.sol', 'Transcript.sol', 'RangeProofVerifier.sol', 'TranscriptProbe.sol'];
  const sources = Object.fromEntries(names.map(name => [name, { content: fs.readFileSync(path.join(root, 'solidity', name), 'utf8') }]));
  const compiled = JSON.parse(solc.compileStandardWrapper(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const diagnostics = compiled.errors || [];
  save('evm-compiler-diagnostics.json', diagnostics);
  assert.equal(diagnostics.filter(item => item.severity === 'error').length, 0, 'Compilation failed');
  const artifact = compiled.contracts['RangeProofVerifier.sol'].RangeProofVerifier;
  const result = { experiment: 'EXP-08', compiler: solc.version(), optimizerRuns: 200,
    sourceSha256: Object.fromEntries(names.map(name => [name, crypto.createHash('sha256').update(sources[name].content).digest('hex')])),
    constructorParametersHash: read('profile.json').expectedParametersHash,
    runtimeBytes: artifact.evm.deployedBytecode.object.length / 2, observations: [] };
  assert(result.runtimeBytes <= 24576);
  fs.mkdirSync(cache, { recursive: true });
  const log = fs.openSync(path.join(cache, 'anvil.log'), 'w');
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18550', '--hardfork', 'prague', '--chain-id', '31337', '--gas-limit', '30000000', '--quiet'], { stdio: ['ignore', log, log] });
  const provider = new JsonRpcProvider('http://127.0.0.1:18550', 31337, { staticNetwork: true });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await provider.send('eth_chainId', []); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(ready, 'Anvil did not start');
    const signer = await provider.getSigner(0);
    const parameters = read('parameters.json');
    const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
    const verifier = await factory.deploy(parameters.base, parameters.gs, parameters.hs, { gasLimit: 29000000n });
    const deployed = await receipt(provider, verifier.deploymentTransaction().hash);
    assert.equal(BigInt(deployed.status), 1n);
    const code = await provider.send('eth_getCode', [await verifier.getAddress(), 'latest']);
    result.deployment = { gasUsed: BigInt(deployed.gasUsed), runtimeKeccak256: keccak256(code) };
    const probeArtifact = compiled.contracts['TranscriptProbe.sol'].TranscriptProbe;
    const probe = await new ContractFactory(probeArtifact.abi, `0x${probeArtifact.evm.bytecode.object}`, signer).deploy();
    await receipt(provider, probe.deploymentTransaction().hash);
    result.pointDecodeBoundaryChecks = [];
    for (const pointCase of [
      { label: 'canonical-identity', x: 0n, y: 0n, expected: true },
      { label: 'x-equals-p', x: BigInt(read('profile.json').coordinateModulus), y: 0n, expected: false },
      { label: 'off-curve', x: 1n, y: 1n, expected: false },
    ]) {
      const accepted = await probe.allowedPoint.staticCall(pointCase.x, pointCase.y);
      const javaCheck = read('java-result.json').pointDecodeBoundaryChecks.find(item => item.label === pointCase.label);
      assert.equal(accepted, pointCase.expected);
      assert.equal(accepted, javaCheck.accepted);
      result.pointDecodeBoundaryChecks.push({ label: pointCase.label, accepted, matchesJava: true });
    }
    const proofs = read('java-result.json').proofs;
    for (const proof of proofs) {
      const args = [proof.operationId, proof.outputIndex, proof.coords, proof.scalars, proof.ls, proof.rs];
      let accepted, returnedNormally, error;
      try { accepted = await verifier.verify.staticCall(...args, { gasLimit: 29000000n }); returnedNormally = true; }
      catch (caught) { accepted = false; returnedNormally = false; error = caught.shortMessage || caught.message; }
      const observed = { label: proof.label, expectedValid: proof.expectedValid, accepted, returnedNormally, error,
        matchesJava: accepted === proof.javaVerifierAccepted, matchesExpectation: accepted === proof.expectedValid };
      result.observations.push(observed);
      save('evm-result.json', result);
      assert(observed.matchesJava && observed.matchesExpectation, `EVM mismatch for ${proof.label}`);
    }
    const valid = proofs.find(proof => proof.expectedValid);
    const profile = read('profile.json');
    let prefix = await probe.initial.staticCall(valid.operationId, valid.outputIndex, valid.coords[0], valid.coords[1]);
    assert.equal(keccak256(prefix), valid.transcriptTrace.initialState);
    result.transcriptStagesChecked = [];
    for (const stage of valid.transcriptTrace.stages) {
      assert.equal(keccak256(prefix), stage.previousState);
      if (stage.stage === 'inner') {
        prefix = await probe.inner.staticCall(prefix, ...stage.P, ...stage.uPoint);
      } else {
        const tag = keccak256(toUtf8Bytes(profile.tags[stage.stage]));
        const candidateTag = keccak256(toUtf8Bytes(profile.tags.candidate));
        const payloadLength = (stage.payloadHex.length - 2) / 2;
        const scalarModulus = BigInt(profile.scalarModulus);
        let expectedCounter = -1;
        for (let index = 0; index <= stage.counter; index++) {
          const candidate = keccak256(concat([prefix, tag, toBeHex(payloadLength, 32), stage.payloadHex,
            candidateTag, toBeHex(index, 32)]));
          assert.equal(candidate, stage.candidates[index], `Direct preimage mismatch at ${stage.stage}/${index}`);
          if (BigInt(candidate) > 0n && BigInt(candidate) < scalarModulus) {
            expectedCounter = index;
            assert.equal(BigInt(candidate).toString(), stage.challenge);
            break;
          }
        }
        assert.equal(expectedCounter, stage.counter);
        const response = await probe.challenge.staticCall(prefix, tag, stage.payloadHex);
        prefix = response[0];
        assert.equal(response[1].toString(), stage.challenge);
        assert.equal(Number(response[2]), stage.counter);
      }
      assert.equal(keccak256(prefix), stage.nextState);
      result.transcriptStagesChecked.push(stage.stage);
    }
    assert.equal(keccak256(prefix), valid.transcriptTrace.finalState);
    const validArgs = [valid.operationId, valid.outputIndex, valid.coords, valid.scalars, valid.ls, valid.rs];
    const transaction = await signer.sendTransaction({
      to: await verifier.getAddress(),
      data: (await verifier.verify.populateTransaction(...validArgs)).data,
      gasLimit: 16777216n,
    });
    const validReceipt = await receipt(provider, transaction.hash);
    assert.equal(BigInt(validReceipt.status), 1n);
    result.validProofTransactionGasUsed = BigInt(validReceipt.gasUsed);
    const alteredOperation = `0x${(BigInt(valid.operationId) ^ 1n).toString(16).padStart(64, '0')}`;
    const changedArgs = [alteredOperation, valid.outputIndex, valid.coords, valid.scalars, valid.ls, valid.rs];
    const changedOperationAccepted = await verifier.verify.staticCall(...changedArgs, { gasLimit: 29000000n });
    result.observations.push({ label: 'changed-operation-id', expectedValid: false, accepted: changedOperationAccepted,
      returnedNormally: true, matchesJava: read('java-result.json').javaMutationChecks.find(item => item.label === 'operation-id-changed').accepted === changedOperationAccepted });
    assert.equal(changedOperationAccepted, false);
    assert.equal(result.observations.at(-1).matchesJava, true);
    result.passed = true;
    save('evm-result.json', result);
    console.log(JSON.stringify({ passed: result.passed, observations: result.observations }));
  } finally {
    anvil.kill('SIGTERM');
    fs.closeSync(log);
    provider.destroy();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
