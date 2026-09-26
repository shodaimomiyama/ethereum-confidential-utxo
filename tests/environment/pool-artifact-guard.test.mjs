import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { artifactPath, outputPath, verifyPoolRecord } from '../../scripts/pool-artifact.mjs';

test('Pool artifact pins ABI, build settings and sources', () => {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const record = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(verifyPoolRecord(record, artifact).schemaVersion, 1);
  assert.equal(record.abi.filter(item => item.type === 'error').length, 15);
  assert.equal(record.abi.filter(item => item.type === 'event').length, 3);
  assert.equal(record.abi.filter(item => item.type === 'function').length, 7);
  assert.ok(record.ast && record.storageLayout);
  assert.throws(() => verifyPoolRecord({ ...record, runtimeBytecode: '0x00' }, artifact));
  assert.throws(() => verifyPoolRecord({ ...record, sourceSha256: {} }, artifact));
});
