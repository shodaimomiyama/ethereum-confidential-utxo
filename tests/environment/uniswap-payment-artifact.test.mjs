import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  artifactPath, createUniswapPaymentRecord, outputPath, verifyUniswapPaymentRecord,
} from '../../scripts/uniswap-payment-artifact.mjs';

test('Adapter artifact pins ABI, build settings, bytecode and sources', () => {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const record = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.deepEqual(verifyUniswapPaymentRecord(record, artifact), createUniswapPaymentRecord(artifact));
  assert.ok(record.ast && record.storageLayout && record.immutableReferences);
  assert.throws(() => verifyUniswapPaymentRecord({ ...record, runtimeBytecode: '0x00' }, artifact));
  assert.throws(() => verifyUniswapPaymentRecord({ ...record, sourceSha256: {} }, artifact));
  assert.throws(() => createUniswapPaymentRecord({ ...artifact, metadata: {
    ...artifact.metadata, settings: { ...artifact.metadata.settings, evmVersion: 'shanghai' },
  } }));
  assert.throws(() => createUniswapPaymentRecord({ ...artifact,
    abi: artifact.abi.filter(item => item.name !== 'pay'),
  }));
  assert.throws(() => createUniswapPaymentRecord({ ...artifact,
    abi: artifact.abi.filter(item => item.name !== 'InvalidConfiguration'),
  }));
});
