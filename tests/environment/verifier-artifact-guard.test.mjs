import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createVerifierRecord, verifyVerifierRecord, validateMeasurements, artifactPath } from '../../scripts/verifier-artifact.mjs';
import { compareDeploymentRecord } from '../../scripts/verifier-deployment.mjs';

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const original = createVerifierRecord(artifact);
const published = JSON.parse(readFileSync('packages/ethereum/generated/verifier-v3.json', 'utf8'));

test('published verifier guard rejects ABI, runtime and constructor mutations', () => {
  const abi = structuredClone(original);
  abi.abi.find(item => item.name === 'verify').name = 'verifyChanged';
  assert.throws(() => verifyVerifierRecord(abi, artifact), /abi mismatch/);
  const runtime = structuredClone(original);
  runtime.runtimeBytecode = `${runtime.runtimeBytecode.slice(0, -2)}00`;
  assert.throws(() => verifyVerifierRecord(runtime, artifact), /runtimeBytecode mismatch/);
  const args = structuredClone(original);
  args.constructorInputSha256 = '0'.repeat(64);
  assert.throws(() => verifyVerifierRecord(args, artifact), /constructorInputSha256 mismatch/);
});

test('compiler settings and complete compiler outputs are pinned', () => {
  assert.match(original.metadata.compiler.version, /^0\.8\.37\+/);
  assert.deepEqual(original.metadata.settings.optimizer, { enabled: true, runs: 200 });
  assert.equal(original.metadata.settings.evmVersion, 'cancun');
  assert.notEqual(original.metadata.settings.viaIR, true);
  assert.ok(original.ast && original.storageLayout);
});

test('measurement schema requires reproducible separate calls', () => {
  const rows = ['deployment', 'range', 'balance'].map(type => ({
    type, inputId: 'VEC-04-VALID-MIN', chainId: 31337, hardfork: 'cancun',
    runtimeSha256: original.manifest.runtimeSha256, compiler: original.manifest.compiler,
    caller: '0x1111111111111111111111111111111111111111', gasUsed: 1, estimateGas: 1,
  }));
  validateMeasurements(rows, original.manifest.runtimeSha256);
  for (const key of ['inputId', 'chainId', 'hardfork', 'runtimeSha256', 'compiler', 'caller', 'type', 'gasUsed']) {
    const mutated = structuredClone(rows);
    delete mutated[1][key];
    assert.throws(() => validateMeasurements(mutated, original.manifest.runtimeSha256), /invalid range measurement/);
  }
  const combined = structuredClone(rows);
  combined[2].type = 'pool-operation';
  assert.throws(() => validateMeasurements(combined, original.manifest.runtimeSha256));
});

test('published guard rejects a record with no gas measurements', () => {
  assert.throws(() => verifyVerifierRecord(original, artifact), /measurements missing/);
  const environment = structuredClone(published);
  delete environment.measurementEnvironment;
  assert.throws(() => verifyVerifierRecord(environment, artifact), /measurement environment missing/);
});

test('deployment comparison rejects changed address, caller and transaction hash', () => {
  for (const key of ['address', 'from', 'transactionHash']) {
    const changed = structuredClone(published.deployment);
    changed[key] = key === 'transactionHash' ? `0x${'00'.repeat(32)}` : `0x${'11'.repeat(20)}`;
    assert.throws(() => compareDeploymentRecord(changed, published.deployment), /deployment .* mismatch/);
  }
});
