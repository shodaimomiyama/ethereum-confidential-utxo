const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const solc = require('solc');
const { ContractFactory, JsonRpcProvider, keccak256 } = require('ethers');

const root = __dirname;
const upstream = path.join(root, '.cache/upstream');
const outputDirectory = path.resolve(root, process.env.EXPERIMENT_OUTPUT || 'outputs');
const bitWidth = Number(process.argv[2] || 4);
const mode = process.argv[3] || 'fixture';
const outputName = `${mode}-${bitWidth}`;
const rpcPort = 18547;
const maximumGas = 29000000n;
fs.mkdirSync(outputDirectory, { recursive: true });

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2)}\n`);
}

function extractBigNumbers(filename) {
  return Array.from(fs.readFileSync(path.join(upstream, filename), 'utf8').matchAll(/new web3.BigNumber\('([^']+)'\)/g), match => BigInt(match[1]).toString());
}

function loadFixture() {
  const constructorNumbers = extractBigNumbers('truffle/migrations/3_RangeProofVerifier.js');
  const innerNumbers = extractBigNumbers('truffle/migrations/2_EfficientInnerProductVerifier.js');
  const proofNumbers = extractBigNumbers('truffle/test/RangeProofVerifier.js');
  assert.equal(constructorNumbers.length, 20);
  assert.equal(innerNumbers.length, 18);
  assert.equal(proofNumbers.length, 23);
  return {
    parameters: {
      base: constructorNumbers.slice(0, 4),
      gs: constructorNumbers.slice(4, 12),
      hs: constructorNumbers.slice(12, 20),
      innerH: innerNumbers.slice(0, 2),
    },
    proofs: [{
      label: 'upstream-fixture',
      expectedValid: true,
      coords: proofNumbers.slice(0, 10),
      scalars: proofNumbers.slice(10, 15),
      ls: proofNumbers.slice(15, 19),
      rs: proofNumbers.slice(19, 23),
    }],
  };
}

function compileVerifiers() {
  const sourceHashes = {};
  const sources = {};
  for (const filename of ['RangeProofVerifier.sol', 'EfficientInnerProductVerifier.sol', 'alt_bn128.sol']) {
    const original = fs.readFileSync(path.join(upstream, 'truffle/contracts', filename), 'utf8');
    const content = original
      .replace('uint256 public constant m = 4;', `uint256 public constant m = ${bitWidth};`)
      .replace('uint256 public constant n = 2;', `uint256 public constant n = ${Math.log2(bitWidth)};`);
    sourceHashes[filename] = {
      upstreamSha256: crypto.createHash('sha256').update(original).digest('hex'),
      compiledSha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
    sources[filename] = { content };
    const sourceDirectory = path.join(root, '.cache', `solidity-${bitWidth}`);
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, filename), content);
  }
  const harnessSource = fs.readFileSync(path.join(root, 'VerificationHarness.sol'), 'utf8');
  sources['VerificationHarness.sol'] = { content: harnessSource };
  sourceHashes['VerificationHarness.sol'] = {
    origin: 'Experiment measurement harness',
    compiledSha256: crypto.createHash('sha256').update(harnessSource).digest('hex'),
  };
  const started = performance.now();
  const compiled = JSON.parse(solc.compileStandardWrapper(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  })));
  writeJson(path.join(outputDirectory, `${outputName}-compiler-diagnostics.json`), compiled.errors || []);
  assert.equal((compiled.errors || []).filter(diagnostic => diagnostic.severity === 'error').length, 0, 'Solidity compilation failed');
  return { compiled, sourceHashes, compileMilliseconds: performance.now() - started };
}

async function awaitReceipt(provider, hash, expectedStatus = 1n) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
    if (receipt !== null) {
      assert.equal(BigInt(receipt.status), expectedStatus);
      return { ...receipt, gasUsed: BigInt(receipt.gasUsed), hash: receipt.transactionHash };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No transaction receipt within 10 seconds: ${hash}`);
}

async function deployContract(compiled, signer, name, arguments_) {
  const artifact = compiled.contracts[`${name}.sol`][name];
  const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
  const started = performance.now();
  const contract = await factory.deploy(...arguments_, { gasLimit: maximumGas });
  const receipt = await awaitReceipt(signer.provider, contract.deploymentTransaction().hash);
  assert.notEqual(await signer.provider.send('eth_getCode', [await contract.getAddress(), 'latest']), '0x');
  return {
    contract,
    measurement: {
      address: await contract.getAddress(),
      gasUsed: receipt.gasUsed,
      milliseconds: performance.now() - started,
      initCodeBytes: artifact.evm.bytecode.object.length / 2,
      runtimeCodeBytes: artifact.evm.deployedBytecode.object.length / 2,
      runtimeCodeKeccak256: keccak256(`0x${artifact.evm.deployedBytecode.object}`),
    },
  };
}

async function evaluateProof(contract, proof, signer, harness) {
  const calldata = contract.interface.encodeFunctionData('verify', [proof.coords, proof.scalars, proof.ls, proof.rs]);
  const started = performance.now();
  const observation = {
    label: proof.label,
    expectedValid: proof.expectedValid,
    calldata,
    calldataBytes: (calldata.length - 2) / 2,
  };
  try {
    observation.accepted = await contract.verify.staticCall(proof.coords, proof.scalars, proof.ls, proof.rs, { gasLimit: maximumGas });
    observation.returnedNormally = true;
  } catch (error) {
    observation.accepted = false;
    observation.returnedNormally = false;
    observation.error = error.shortMessage || error.message;
    observation.errorCode = error.code || null;
    observation.errorData = error.data || null;
    if (error.code !== 'CALL_EXCEPTION') throw error;
  }
  observation.callMilliseconds = performance.now() - started;
  if (observation.accepted) {
    const transaction = await signer.sendTransaction({ to: await contract.getAddress(), data: calldata, gasLimit: maximumGas });
    const receipt = await awaitReceipt(signer.provider, transaction.hash);
    observation.gasUsed = receipt.gasUsed;
    observation.gasScope = 'Direct verifier transaction; acceptance established by preceding eth_call';
    observation.transactionHash = receipt.hash;
    if (harness) {
      const guardedTransaction = await signer.sendTransaction({ to: await harness.getAddress(), data: calldata, gasLimit: maximumGas });
      const guardedReceipt = await awaitReceipt(signer.provider, guardedTransaction.hash);
      observation.harness = {
        gasUsed: guardedReceipt.gasUsed,
        calldataBytes: observation.calldataBytes,
        transactionHash: guardedReceipt.hash,
        status: '1',
        assertion: 'STATICCALL succeeded, returndata length is 32 bytes, and returned uint256 equals 1',
      };
    }
  }
  observation.matchesExpectation = observation.accepted === observation.expectedValid;
  return observation;
}

async function main() {
  assert([4, 64].includes(bitWidth));
  const inputs = mode === 'fixture' ? loadFixture() : readJson(path.join(outputDirectory, `java-${bitWidth}.json`));
  writeJson(path.join(outputDirectory, `${outputName}-inputs.json`), inputs);
  const compilation = compileVerifiers();
  const run = {
    bitWidth,
    mode,
    compiler: solc.version(),
    optimizer: { enabled: true, runs: 200 },
    hardfork: 'prague',
    sourceHashes: compilation.sourceHashes,
    compileMilliseconds: compilation.compileMilliseconds,
    deployments: {},
    observations: [],
    observationFields: {
      accepted: 'Boolean returned by verifier; false also used for a recorded CALL_EXCEPTION rejection',
      returnedNormally: 'eth_call returned a decoded boolean without reverting',
    },
  };
  const log = fs.openSync(path.join(outputDirectory, `${outputName}-anvil.log`), 'w');
  const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--hardfork', 'prague', '--chain-id', '31337', '--gas-limit', '30000000', '--quiet'], { stdio: ['ignore', log, log] });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${rpcPort}`, 31337, { staticNetwork: true });
  provider.pollingInterval = 10;
  try {
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (node.exitCode !== null) throw new Error(`Anvil exited with ${node.exitCode}`);
      try {
        await provider.send('eth_chainId', []);
        started = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert(started, 'Anvil did not start');
    const signer = await provider.getSigner(0);
    const parameters = inputs.parameters;
    const inner = await deployContract(compilation.compiled, signer, 'EfficientInnerProductVerifier', [...parameters.innerH, parameters.gs, parameters.hs]);
    run.deployments.innerProduct = inner.measurement;
    const range = await deployContract(compilation.compiled, signer, 'RangeProofVerifier', [parameters.base, parameters.gs, parameters.hs, inner.measurement.address]);
    run.deployments.rangeProof = range.measurement;
    let harness;
    if (bitWidth === 64 && mode === 'fresh') {
      const deployment = await deployContract(compilation.compiled, signer, 'VerificationHarness', [range.measurement.address]);
      harness = deployment.contract;
      run.deployments.verificationHarness = deployment.measurement;
    }
    const validProof = inputs.proofs.find(proof => proof.expectedValid && !proof.proverError);
    assert(validProof, 'No valid proof supplied');
    const scalarMutation = structuredClone(validProof);
    scalarMutation.label = `${validProof.label}-modified-tauX`;
    scalarMutation.expectedValid = false;
    scalarMutation.scalars[0] = (BigInt(scalarMutation.scalars[0]) + 1n).toString();
    const commitmentMutation = structuredClone(validProof);
    commitmentMutation.label = `${validProof.label}-modified-commitment`;
    commitmentMutation.expectedValid = false;
    commitmentMutation.coords[0] = '1';
    commitmentMutation.coords[1] = '2';
    let submittedProofs = [...inputs.proofs, scalarMutation, commitmentMutation];
    if (mode === 'diagnostics') {
      const groupOrder = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      submittedProofs = ['tauX', 'mu', 't', 'a', 'b'].map((scalarName, index) => {
        const nonCanonical = structuredClone(validProof);
        nonCanonical.label = `${validProof.label}-${scalarName}-plus-q`;
        nonCanonical.expectedValid = false;
        nonCanonical.scalars[index] = (BigInt(nonCanonical.scalars[index]) + groupOrder).toString();
        return nonCanonical;
      });
    }
    for (const proof of submittedProofs) {
      if (proof.proverError) {
        run.observations.push({ label: proof.label, notSubmitted: true, proverError: proof.proverError, expectedValid: proof.expectedValid });
      } else {
        run.observations.push(await evaluateProof(range.contract, proof, signer, harness));
      }
    }
    if (harness) {
      const falseProof = run.observations.find(observation => observation.label.endsWith('-modified-tauX'));
      assert.equal(falseProof.returnedNormally, true);
      assert.equal(falseProof.accepted, false);
      const rejectedTransaction = await signer.sendTransaction({ to: await harness.getAddress(), data: falseProof.calldata, gasLimit: maximumGas });
      const rejectedReceipt = await awaitReceipt(signer.provider, rejectedTransaction.hash, 0n);
      run.harnessFalseResult = {
        proofLabel: falseProof.label,
        underlyingVerifierReturnedFalse: true,
        transactionHash: rejectedReceipt.hash,
        status: '0',
        gasUsed: rejectedReceipt.gasUsed,
        calldataBytes: falseProof.calldataBytes,
      };
    }
    const expectationsSatisfied = run.observations.every(observation => observation.notSubmitted ? !observation.expectedValid : observation.matchesExpectation);
    if (mode === 'diagnostics') {
      run.diagnosticCompleted = true;
      run.canonicalRejectionSatisfied = expectationsSatisfied;
    } else {
      run.succeeded = expectationsSatisfied;
    }
  } catch (error) {
    run.succeeded = false;
    run.failure = { message: error.message, code: error.code || null };
    throw error;
  } finally {
    writeJson(path.join(outputDirectory, `${outputName}-evm.json`), run);
    provider.destroy();
    node.kill('SIGTERM');
    fs.closeSync(log);
  }
  console.log(JSON.stringify({ stage: outputName, succeeded: run.succeeded, diagnosticCompleted: run.diagnosticCompleted, canonicalRejectionSatisfied: run.canonicalRejectionSatisfied, observations: run.observations.map(({ calldata, ...observation }) => observation) }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  if (mode !== 'diagnostics') assert(run.succeeded, 'Stage observations did not match expectations');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
