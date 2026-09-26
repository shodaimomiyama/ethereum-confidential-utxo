import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createVerifierRecord, verifyVerifierRecord, artifactPath } from '../../scripts/verifier-artifact.mjs';

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const original = createVerifierRecord(artifact);

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
