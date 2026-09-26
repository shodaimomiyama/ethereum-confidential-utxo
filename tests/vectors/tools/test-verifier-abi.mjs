import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { buildVerifierAbiCases } from './oracle-verifier-abi.mjs';

const saved = JSON.parse(readFileSync(new URL('../cases/verifier-abi.json', import.meta.url)));

test('fixed verifier selectors and complete calldata round trip', () => {
  const generated = buildVerifierAbiCases();
  assert.deepEqual(generated, saved);
  const abi = new Interface([
    'function verify(bytes32 operationId,uint256 outputIndex,uint256[10] coords,uint256[5] scalars,uint256[] ls,uint256[] rs) view returns (bool)',
    'function verifyBalance(bytes32 operationId,uint256 Xx,uint256 Xy,uint256 Rx,uint256 Ry,uint256 s) view returns (bool)',
  ]);
  for (const item of saved) {
    assert.equal(item.expected.calldata.slice(0, 10), item.expected.selector);
    const parsed = abi.parseTransaction({ data: item.expected.calldata });
    assert.equal(parsed.name, item.input.function);
    assert.equal(parsed.args.operationId.toLowerCase(), item.input.operationId.toLowerCase());
    if (item.input.function === 'verify') {
      assert.equal(parsed.args.coords.length, 10);
      assert.equal(parsed.args.scalars.length, 5);
      assert.equal(parsed.args.ls.length, 12);
      assert.equal(parsed.args.rs.length, 12);
    }
  }
});
