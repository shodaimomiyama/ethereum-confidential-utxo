const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const load = createRequire(path.resolve(__dirname, '../../bulletproof/package.json'));
const { ContractFactory, JsonRpcProvider, keccak256 } = load('ethers');
const oldRoot = path.resolve(__dirname, '../../bulletproof-revised');
const oldOutput = path.join(oldRoot, 'outputs/locked-reproduction');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = value => fs.writeFileSync(path.join(__dirname, 'v1-comparison.json'), JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');

async function receipt(provider, hash) {
  for (let i = 0; i < 100; i++) {
    const found = await provider.send('eth_getTransactionReceipt', [hash]);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Transaction receipt unavailable');
}

async function main() {
  const artifact = read(path.join(oldOutput, 'compiled-contracts.json'))['RangeProofVerifier.sol'].RangeProofVerifier;
  const inputs = read(path.join(oldOutput, 'java-64.json'));
  const valid = inputs.proofs.find(item => item.label === 'amount-1-blinding-42');
  assert(valid?.javaVerifierAccepted);
  const log = fs.openSync(path.join(__dirname, '.cache/anvil-v1.log'), 'w');
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18550', '--hardfork', 'prague', '--chain-id', '31337', '--gas-limit', '30000000', '--quiet'], { stdio: ['ignore', log, log] });
  const provider = new JsonRpcProvider('http://127.0.0.1:18550', 31337, { staticNetwork: true });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await provider.send('eth_chainId', []); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(ready);
    const signer = await provider.getSigner(0);
    const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer);
    const verifier = await factory.deploy(inputs.parameters.base, inputs.parameters.gs, inputs.parameters.hs, { gasLimit: 16777216n });
    assert.equal(BigInt((await receipt(provider, verifier.deploymentTransaction().hash)).status), 1n);
    const args = [valid.operationId, valid.outputIndex, valid.coords, valid.scalars, valid.ls, valid.rs];
    assert.equal(await verifier.verify.staticCall(...args, { gasLimit: 16777216n }), true);
    const transaction = await signer.sendTransaction({ to: await verifier.getAddress(),
      data: (await verifier.verify.populateTransaction(...args)).data, gasLimit: 16777216n });
    const completed = await receipt(provider, transaction.hash);
    assert.equal(BigInt(completed.status), 1n);
    const code = await provider.send('eth_getCode', [await verifier.getAddress(), 'latest']);
    const result = { experiment: 'EXP-07B v1 comparison', hardfork: 'prague', gasLimit: 16777216,
      scope: 'Direct transaction to standalone RangeProofVerifier.verify, amount=1 and blinding=42; no harness, probe, Pool or PoK',
      gasUsed: BigInt(completed.gasUsed), runtimeBytes: code.length / 2 - 1, runtimeKeccak256: keccak256(code), parametersHash: inputs.parametersHash };
    save(result);
    console.log(result);
  } finally {
    anvil.kill('SIGTERM');
    fs.closeSync(log);
    provider.destroy();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
