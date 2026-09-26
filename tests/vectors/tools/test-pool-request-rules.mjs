import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const rejected = JSON.parse(readFileSync(new URL('../cases/operation-rejected.json', import.meta.url)));
const accepted = JSON.parse(readFileSync(new URL('../cases/operation.json', import.meta.url)));

test('zero output owner and zero withdrawal destination have independent request cases', () => {
  const owner = rejected.find(item => item.id === 'VEC-01-ZERO-OUTPUT-OWNER');
  const destination = rejected.find(item => item.id === 'VEC-01-ZERO-WITHDRAW-DESTINATION');
  assert.equal(owner.expected.reason, 'InvalidRequest');
  assert.equal(owner.input.outputs[0].owner, '0x0000000000000000000000000000000000000000');
  assert.equal(destination.expected.reason, 'InvalidRequest');
  assert.equal(destination.input.kind, 2);
  assert.equal(destination.input.destination, '0x0000000000000000000000000000000000000000');
  const self = accepted.find(item => item.id === 'VEC-01-WITHDRAW-SELF');
  assert.match(self.expected.operationId, /^0x[0-9a-f]{64}$/);
  assert.equal(self.input.destination.toLowerCase(), self.input.pool.toLowerCase());
  const deposit = accepted.find(item => item.id === 'VEC-01-DEPOSIT');
  assert.equal(deposit.input.destination, '0x0000000000000000000000000000000000000000');
});
