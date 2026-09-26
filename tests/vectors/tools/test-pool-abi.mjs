import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Interface } from 'ethers';

const request = '(uint8,address,bytes32,bytes32[],(address,uint256,uint256,uint8,bytes)[],uint256,uint256,address)';
const balance = '(uint256,uint256,uint256)';
const range = '(uint256[10],uint256[5],uint256[],uint256[])';
const independent = new Interface([
  `function deposit(${request},${balance},bytes) payable`,
  `function transfer(${request},${balance},${range}[],bytes)`,
  `function withdraw(${request},${balance},${range}[],bytes)`,
  'function getUtxo(bytes32) view returns (uint8,address,uint256,uint256)',
  'function isOperationExecuted(bytes32) view returns (bool)',
  'function getAccounting() view returns (uint256,uint256,uint256)',
  'error InvalidRequest()', 'error PublicAmountOutOfRange()',
  'error MsgValueMismatch(uint256,uint256)', 'error ReentrantOperation()',
  'error InputNotFound(bytes32)', 'error InputAlreadySpent(bytes32)',
  'error DuplicateInput(bytes32)', 'error InputOwnerMismatch(bytes32)',
  'error OperationAlreadyExecuted(bytes32)', 'error OutputIdCollision(bytes32)',
  'error InvalidAuthorization()', 'error InvalidBalanceProof()',
  'error InvalidRangeProof(uint256)', 'error WithdrawalFailed(address,uint256)',
  'error AccountingInvariantViolation()',
  'event InputConsumed(bytes32 indexed inputId,bytes32 indexed operationId)',
  'event OutputCreated(address indexed owner,bytes32 indexed utxoId,bytes32 indexed operationId,uint256 outputIndex,uint256 Cx,uint256 Cy,uint8 receiptFormat,bytes packet)',
  'event OperationSucceeded(bytes32 indexed operationId,uint8 kind,address indexed owner,bytes32[] inputIds,bytes32[] outputIds,uint256 d,uint256 w,address destination,bytes32 salt)',
]);

test('Pool entrypoint selectors and calldata match an independent ABI declaration', () => {
  const artifact = JSON.parse(readFileSync('contracts/out/IPool.sol/IPool.json', 'utf8'));
  const compiled = new Interface(artifact.abi);
  const example = JSON.parse(readFileSync('tests/vectors/cases/application-operation.json', 'utf8'))[0];
  const input = example.input;
  const proof = example.expected.balanceProof;
  const requestValue = [input.kind, input.owner, input.salt, input.inputIds,
    input.outputs.map(output => [output.owner, output.Cx, output.Cy, output.receiptFormat, output.packet]),
    input.d, input.w, input.destination];
  const balanceValue = [...proof.R, proof.s];
  for (const name of ['deposit', 'transfer', 'withdraw']) {
    assert.equal(compiled.getFunction(name).selector, independent.getFunction(name).selector);
    const args = name === 'deposit'
      ? [requestValue, balanceValue, example.expected.authorizationSignature]
      : [requestValue, balanceValue, [], example.expected.authorizationSignature];
    assert.equal(compiled.encodeFunctionData(name, args), independent.encodeFunctionData(name, args));
  }
  for (const name of ['getUtxo', 'isOperationExecuted', 'getAccounting']) {
    assert.equal(compiled.getFunction(name).selector, independent.getFunction(name).selector);
  }
  for (const entry of artifact.abi.filter(item => item.type === 'error')) {
    assert.equal(compiled.getError(entry.name).selector, independent.getError(entry.name).selector);
  }
  for (const entry of artifact.abi.filter(item => item.type === 'event')) {
    assert.equal(compiled.getEvent(entry.name).topicHash, independent.getEvent(entry.name).topicHash);
    assert.deepEqual(entry.inputs.map(input => input.indexed),
      independent.getEvent(entry.name).inputs.map(input => input.indexed ?? false));
  }
  assert.equal(artifact.abi.filter(item => item.type === 'error').length, 15);
  assert.equal(artifact.abi.filter(item => item.type === 'event').length, 3);
});

test('published Pool calldata decodes through the independent interface', () => {
  const cases = JSON.parse(readFileSync('tests/vectors/cases/pool-operations.json', 'utf8'));
  const fixture = JSON.parse(readFileSync('contracts/test/fixtures/pool-calldata.json', 'utf8'));
  for (const entry of cases) {
    const name = entry.id.replace('VEC-07-POOL-', '').replaceAll('-', '_');
    const method = ['deposit', 'transfer', 'withdraw'][entry.input.kind];
    const decoded = independent.decodeFunctionData(method, fixture[name].calldata);
    assert.equal(decoded[0][1].toLowerCase(), entry.input.owner, entry.id);
    assert.equal(decoded[0][3].length, entry.input.inputIds.length, entry.id);
    assert.equal(decoded[0][4].length, entry.input.outputs.length, entry.id);
    assert.equal(decoded[0][5].toString(), entry.input.d, entry.id);
    assert.equal(decoded[0][6].toString(), entry.input.w, entry.id);
    assert.equal(decoded[0][7].toLowerCase(), entry.input.destination, entry.id);
  }
});
