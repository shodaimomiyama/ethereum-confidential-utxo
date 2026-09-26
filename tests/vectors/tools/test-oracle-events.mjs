import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { buildObservationCases, validateSyncLogs } from './oracle-abi.mjs';

const root = new URL('../cases/', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('abi-observation.json', root), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('operation.json', root), 'utf8'));
const abi = new Interface([
  'event InputConsumed(bytes32 indexed inputId,bytes32 indexed operationId)',
  'event OutputCreated(address indexed owner,bytes32 indexed utxoId,bytes32 indexed operationId,uint256 outputIndex,uint256 Cx,uint256 Cy,uint8 receiptFormat,bytes packet)',
  'event OperationSucceeded(bytes32 indexed operationId,uint8 kind,address indexed owner,bytes32[] inputIds,bytes32[] outputIds,uint256 d,uint256 w,address destination,bytes32 salt)',
  'function getUtxo(bytes32 utxoId) view returns(uint8 status,address owner,uint256 Cx,uint256 Cy)',
  'function isOperationExecuted(bytes32 operationId) view returns(bool executed)',
  'function getAccounting() view returns(uint256 actualBalance,uint256 accountedLiability,uint256 unaccountedEth)',
  'error InvalidRequest()', 'error PublicAmountOutOfRange()',
  'error MsgValueMismatch(uint256 expected,uint256 actual)', 'error ReentrantOperation()',
  'error InputNotFound(bytes32 inputId)', 'error InputAlreadySpent(bytes32 inputId)',
  'error DuplicateInput(bytes32 inputId)', 'error InputOwnerMismatch(bytes32 inputId)',
  'error OperationAlreadyExecuted(bytes32 operationId)', 'error OutputIdCollision(bytes32 outputId)',
  'error InvalidAuthorization()', 'error InvalidBalanceProof()',
  'error InvalidRangeProof(uint256 outputIndex)',
  'error WithdrawalFailed(address destination,uint256 amount)',
  'error AccountingInvariantViolation()',
]);
const find = id => cases.find(item => item.id === id);
const comparable = value => String(value).toLowerCase();

test('generator exactly reproduces fixed ABI observations', () => {
  assert.deepEqual(buildObservationCases(operations), cases);
});

test('event topics, dynamic data and packet decode with independent ABI', () => {
  for (const entry of cases.filter(item => item.stage === 'sync-log' && item.expected.decision === 'accept')) {
    const operation = operations.find(item => item.id === entry.input.operationCase);
    const logs = entry.expected.logs;
    assert.deepEqual(logs.map(log => log.name), [
      ...operation.input.inputIds.map(() => 'InputConsumed'),
      ...operation.input.outputs.map(() => 'OutputCreated'), 'OperationSucceeded',
    ]);
    for (const log of logs) {
      const parsed = abi.parseLog({ topics: log.topics, data: log.data });
      assert.equal(parsed.name, log.name);
      assert.equal(log.topics[0], abi.getEvent(log.name).topicHash);
      assert.deepEqual(parsed.args.toArray().map(comparable), log.args.map(comparable));
    }
    assert.equal(validateSyncLogs(operation, logs), true);
  }
});

test('missing, reordered, mismatched ID and changed packet logs reject at sync stage', () => {
  for (const entry of cases.filter(item => item.stage === 'sync-log' && item.expected.decision === 'reject')) {
    const operation = operations.find(item => item.id === entry.input.operationCase);
    assert.equal(validateSyncLogs(operation, entry.input.logs), false, entry.id);
  }
});

test('query selectors and return tuples decode independently', () => {
  for (const entry of cases.filter(item => item.stage === 'query' && item.expected.decision === 'accept')) {
    const { name, args } = entry.input;
    assert.equal(entry.expected.calldata, abi.encodeFunctionData(name, args));
    assert.deepEqual(abi.decodeFunctionResult(name, entry.expected.returndata).toArray().map(comparable),
      entry.expected.values.map(comparable));
  }
  assert.deepEqual(find('VEC-06-GET-UTXO-ABSENT').expected.values,
    [0, '0x0000000000000000000000000000000000000000', '0', '0']);
  assert.equal(find('VEC-06-GET-UTXO-SPENT').expected.values[0], 2);
  assert.equal(find('VEC-06-ACCOUNTING-DEFICIT').expected.error, 'AccountingInvariantViolation');
});

test('all fifteen custom errors have exact independent selector and arguments', () => {
  const errors = cases.filter(item => item.stage === 'error');
  assert.equal(errors.length, 15);
  for (const entry of errors) {
    const { name, args } = entry.input;
    assert.equal(entry.expected.selector, abi.getError(name).selector);
    assert.equal(entry.expected.data, abi.encodeErrorResult(name, args));
    const parsed = abi.parseError(entry.expected.data);
    assert.equal(parsed.name, name);
    assert.deepEqual(parsed.args.toArray().map(String), args.map(String));
  }
});
