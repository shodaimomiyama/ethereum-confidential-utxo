import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { recoverAddress } from 'ethers';
import { authorizationDigest, buildOperation } from './oracle-abi.mjs';

test('Pool scenarios carry real signatures and correctly bound operation IDs', () => {
  const cases = JSON.parse(readFileSync('tests/vectors/cases/pool-operations.json', 'utf8'));
  const names = new Set(cases.map(item => item.id));
  for (const name of ['DEPOSIT-TEN', 'TRANSFER-FULL', 'TRANSFER-PARTIAL', 'CONSOLIDATE',
    'WITHDRAW-FULL', 'WITHDRAW-PARTIAL', 'SELF-MERGE', 'SELF-SPLIT', 'RECREATE',
    'TWO-MAX-OUTPUTS', 'WITHDRAW-MAX', 'WITHDRAW-CALLBACK-FULL', 'WITHDRAW-SELF',
    'RECIPIENT-REUSE', 'DEPOSIT-BLIND', 'TRANSFER-BLIND']) {
    assert.ok(names.has(`VEC-07-POOL-${name}`), name);
  }
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const entry of cases) {
    assert.equal(entry.expected.operationId, buildOperation(entry.input).operationId, entry.id);
    const digest = authorizationDigest({ chainId: entry.input.chainId, pool: entry.input.pool },
      { operationId: entry.expected.operationId, owner: entry.input.owner });
    assert.equal(recoverAddress(digest, entry.expected.signature).toLowerCase(),
      entry.input.owner.toLowerCase(), entry.id);
    assert.equal(entry.expected.rangeProofs.length, entry.input.kind === 0 ? 0 : entry.input.outputs.length);
  }
});
