const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { keccak256 } = require('../../bulletproof/node_modules/ethers');

const root = __dirname;
const artifactPath = 'out/VerifierSlice.t.sol/VerifierSliceTest.json';
const artifactBytes = fs.readFileSync(path.join(root, artifactPath));
const artifact = JSON.parse(artifactBytes);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = {};
for (const filename of ['src/alt_bn128.sol', 'test/VerifierSlice.t.sol']) {
  const contents = fs.readFileSync(path.join(root, filename));
  const digest = keccak256(contents);
  assert.equal(artifact.metadata.sources[filename].keccak256, digest);
  sources[filename] = { sha256: sha256(contents), keccak256: digest, matchesCompilerMetadata: true };
}
const original = fs.readFileSync(path.resolve(root, '../../bulletproof-revised/solidity/alt_bn128.sol'));
assert(original.equals(fs.readFileSync(path.join(root, 'src/alt_bn128.sol'))));
assert.equal(artifact.metadata.compiler.version, '0.4.19+commit.c4cbbb05');
assert.equal(artifact.metadata.settings.optimizer.enabled, false);
const record = {
  sourceCopyByteIdentical: true,
  originalSource: '../../bulletproof-revised/solidity/alt_bn128.sol',
  originalSourceSha256: sha256(original),
  sources,
  foundryConfigurationSha256: sha256(fs.readFileSync(path.join(root, 'foundry.toml'))),
  artifact: { path: artifactPath, sha256: sha256(artifactBytes) },
  compiler: artifact.metadata.compiler,
  optimizer: artifact.metadata.settings.optimizer,
  requestedEvmVersion: 'byzantium',
  compilerMetadataEvmVersion: artifact.metadata.settings.evmVersion ?? null,
  evmVersionCaveat: 'Foundry configuration and concrete test schedule use Byzantium; solc 0.4.19 metadata does not report an EVM version. This scalar slice uses no precompiles or fork-specific instructions.',
  abi: artifact.abi,
  methodIdentifiers: artifact.methodIdentifiers,
  creationBytecode: {
    object: artifact.bytecode.object,
    bytes: (artifact.bytecode.object.length - 2) / 2,
    keccak256: keccak256(artifact.bytecode.object),
    sha256: sha256(Buffer.from(artifact.bytecode.object.slice(2), 'hex')),
  },
  deployedBytecode: {
    object: artifact.deployedBytecode.object,
    bytes: (artifact.deployedBytecode.object.length - 2) / 2,
    keccak256: keccak256(artifact.deployedBytecode.object),
    sha256: sha256(Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex')),
  },
  hashImplementation: 'ethers 6.13.4, existing EXP-01 pinned dependency; Node crypto for SHA256',
  formalProofCompleted: false,
};
fs.writeFileSync(path.join(root, 'outputs/target-bytecode.json'), `${JSON.stringify(record, null, 2)}\n`);
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.source.sha256, record.originalSourceSha256);
manifest.source.compilerMetadataMatchesExactFiles = true;
manifest.source.compiledSourceHashes = record.sources;
manifest.compiledArtifact = {
  ...record.artifact,
  metadata: artifact.metadata,
  creationBytecodeSha256: record.creationBytecode.sha256,
  creationBytecodeKeccak256: record.creationBytecode.keccak256,
  deployedBytecodeSha256: record.deployedBytecode.sha256,
  deployedBytecodeKeccak256: record.deployedBytecode.keccak256,
  foundryConfigurationSha256: record.foundryConfigurationSha256,
  compilerMetadataEvmVersion: record.compilerMetadataEvmVersion,
  evmVersionCaveat: record.evmVersionCaveat,
  detailedRecord: 'outputs/target-bytecode.json',
};
const testExecution = JSON.parse(fs.readFileSync(path.join(root, 'outputs/test.json'), 'utf8'));
const testLog = fs.readFileSync(path.join(root, 'outputs/test.log'), 'utf8');
assert.equal(testExecution.exitCode, 0);
assert.equal(testExecution.status, 'completed');
assert(testLog.includes('[PASS] test_negZeroReturnsZero()'));
assert(testLog.includes('[PASS] test_subBoundaryInputsStayCanonical()'));
assert(testLog.includes('[PASS] test_subCanonicalInputsStayCanonical(uint256,uint256) (runs: 256'));
manifest.concreteTests = {
  status: 'passed',
  tests: 3,
  fuzzRuns: 256,
  explicitCanonicalBoundaryPairs: 6,
  executionRecord: 'outputs/test.json',
  rawLog: 'outputs/test.log',
  isFormalProof: false,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ artifactSha256: record.artifact.sha256, deployedKeccak256: record.deployedBytecode.keccak256, sourceMetadataMatches: true }));
