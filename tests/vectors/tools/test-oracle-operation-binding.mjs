import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AbiCoder, id, keccak256 } from 'ethers';
import { buildOperation } from './oracle-abi.mjs';
import { buildBindingCases, applyMutation } from './oracle-operation-binding.mjs';

const operations = JSON.parse(readFileSync(new URL('../cases/operation.json', import.meta.url)));
const saved = JSON.parse(readFileSync(new URL('../cases/operation-binding.json', import.meta.url)));
const base = operations.find(item => item.id === 'VEC-01-TRANSFER-CHANGE');

test('every required logical operation field changes operationId', () => {
  const changed = saved.filter(item => item.expected.relation === 'different');
  assert.deepEqual(changed.map(item => item.mutatedField), [
    'chainId', 'pool', 'owner', 'salt', 'kind', 'd', 'w', 'destination',
    'inputIds[0]', 'outputs[0].owner', 'outputs[0].Cx', 'outputs[0].Cy',
    'outputs[0].receiptFormat', 'outputs[0].packet',
  ]);
  for (const item of changed) {
    const result = buildOperation(applyMutation(base.input, item.mutatedField,
      item.input.replacement));
    assert.equal(result.operationId, item.expected.operationId, item.id);
    assert.equal(result.operationPreimage, item.expected.operationPreimage, item.id);
    assert.notEqual(result.operationId, base.expected.operationId, item.id);
  }
});

test('proof, signature, sender and outer transaction nonce do not enter operationId', () => {
  const unchanged = saved.filter(item => item.expected.relation === 'same');
  assert.deepEqual(unchanged.map(item => item.mutatedField),
    ['proof', 'signature', 'sender', 'txNonce']);
  for (const item of unchanged) {
    const result = buildOperation(applyMutation(base.input, item.mutatedField,
      item.input.replacement));
    assert.equal(result.operationId, base.expected.operationId, item.id);
    assert.equal(result.operationPreimage, base.expected.operationPreimage, item.id);
    assert.equal(item.expected.operationId, base.expected.operationId, item.id);
  }
});

test('ethers independently reproduces representative nested output and input mutations', () => {
  const coder = AbiCoder.defaultAbiCoder();
  for (const name of ['VEC-01-BIND-INPUT-IDS-0', 'VEC-01-BIND-OUTPUTS-0-PACKET']) {
    const item = saved.find(value => value.id === name);
    assert.ok(item, name);
    const input = applyMutation(base.input, item.mutatedField, item.input.replacement);
    const inputIdsHash = keccak256(coder.encode(['bytes32', 'bytes32[]'],
      [id('ecu/inputs/v1'), input.inputIds]));
    const outputHashes = input.outputs.map((output, index) => keccak256(coder.encode(
      ['bytes32', 'uint256', 'address', 'uint256', 'uint256', 'uint8', 'bytes32'],
      [id('ecu/output/v1'), index, output.owner, output.Cx, output.Cy,
        output.receiptFormat, keccak256(output.packet)],
    )));
    const outputsHash = keccak256(coder.encode(['bytes32', 'bytes32[]'],
      [id('ecu/outputs/v1'), outputHashes]));
    const preimage = coder.encode(
      ['bytes32', 'uint256', 'address', 'uint8', 'address', 'bytes32',
        'bytes32', 'bytes32', 'uint256', 'uint256', 'address'],
      [id('ecu/operation/v1'), input.chainId, input.pool, input.kind, input.owner,
        input.salt, inputIdsHash, outputsHash, input.d, input.w, input.destination],
    );
    assert.equal(preimage, item.expected.operationPreimage, name);
    assert.equal(keccak256(preimage), item.expected.operationId, name);
  }
});

test('regeneration writes exact checked-in cases to another directory', () => {
  assert.deepEqual(buildBindingCases(), saved);
  const output = mkdtempSync(join(tmpdir(), 'ecu-operation-binding-'));
  try {
    const run = spawnSync(process.execPath,
      ['tests/vectors/tools/oracle-operation-binding.mjs', '--out', output],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(output, 'operation-binding.json'), 'utf8'),
      readFileSync(new URL('../cases/operation-binding.json', import.meta.url), 'utf8'));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
