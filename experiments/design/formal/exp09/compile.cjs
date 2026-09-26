const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = __dirname;
const sourceRoot = path.resolve(root, '../../crypto-profile-v3/exp08/solidity');
const load = createRequire(path.resolve(root, '../../bulletproof/package.json'));
const solc = load('solc');
const { keccak256 } = load('ethers');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json')));
const names = ['alt_bn128.sol', 'Transcript.sol', 'RangeProofVerifier.sol'];
const sources = Object.fromEntries(names.map(name => [name, {
  content: fs.readFileSync(path.join(sourceRoot, name), 'utf8')
}]));

assert(solc.version().startsWith(plan.target.compiler.replace(/^solc /, '')));
const compiled = JSON.parse(solc.compileStandardWrapper(JSON.stringify({
  language: 'Solidity', sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
})));
assert.equal((compiled.errors || []).filter(x => x.severity === 'error').length, 0);
const runtime = compiled.contracts['RangeProofVerifier.sol'].RangeProofVerifier.evm.deployedBytecode.object;
const result = {
  compiler: solc.version(),
  sourceSha256: Object.fromEntries(names.map(name => [name, crypto.createHash('sha256').update(sources[name].content).digest('hex')])),
  runtimeBytes: runtime.length / 2,
  runtimeKeccak256: keccak256(`0x${runtime}`),
  runtimeSha256: crypto.createHash('sha256').update(Buffer.from(runtime, 'hex')).digest('hex')
};
assert.equal(result.runtimeBytes, plan.target.runtimeBytes);
assert.equal(result.runtimeKeccak256, plan.target.runtimeKeccak256);
fs.writeFileSync(path.join(root, 'runtime.hex'), runtime + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(root, 'compile-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
