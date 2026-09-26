import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AbiCoder, TypedDataEncoder, keccak256 as ethersKeccak, recoverAddress } from 'ethers';
import { inputIdsHash, buildOperation, authorizationDigest, recipientInfoParts } from './oracle-abi.mjs';

test('empty input list has a complete ABI preimage and known Keccak digest', () => {
  const result = inputIdsHash([]);
  assert.equal(result.preimage,
    '0x4d30e29d6e4b2125549a0cb5776ff0fb3bcaa7d98c2800365dc4bf4976b76787' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(result.hash, '0x97d7f3395f2a58005ceac0d68c35e6d75eb19be98f44bb84efe73088c421c1bf');
  assert.equal(ethersKeccak(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[]'],
    ['0x4d30e29d6e4b2125549a0cb5776ff0fb3bcaa7d98c2800365dc4bf4976b76787', []],
  )), result.hash);
});

test('operation context changes its identifier but proof bytes do not', () => {
  const input = {
    chainId: '31337', pool: '0x1111111111111111111111111111111111111111',
    kind: 0, owner: '0x2222222222222222222222222222222222222222',
    salt: '0x' + '33'.repeat(32), inputIds: [],
    outputs: [{ owner: '0x2222222222222222222222222222222222222222',
      Cx: '1', Cy: '2', receiptFormat: 1, packet: '0x' + '44'.repeat(112) }],
    d: '1', w: '0', destination: '0x0000000000000000000000000000000000000000',
  };
  const result = buildOperation(input);
  assert.equal(result.info.length, 1);
  assert.equal(result.outputIds.length, 1);
  assert.notEqual(buildOperation({ ...input, chainId: '31338' }).operationId, result.operationId);
  assert.equal(buildOperation({ ...input, proof: '0xdeadbeef' }).operationId, result.operationId);
  assert.notEqual(buildOperation({ ...input, outputs: [{ ...input.outputs[0], packet: '0x' + '45'.repeat(112) }] }).operationId, result.operationId);
});

test('EIP-712 operation digest binds owner and operation ID', () => {
  const domain = { chainId: '31337', pool: '0x1111111111111111111111111111111111111111' };
  const data = { operationId: '0x' + '55'.repeat(32), owner: '0x2222222222222222222222222222222222222222' };
  const digest = authorizationDigest(domain, data);
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  assert.notEqual(authorizationDigest({ ...domain, chainId: '31338' }, data), digest);
  assert.notEqual(authorizationDigest(domain, { ...data, owner: '0x3333333333333333333333333333333333333333' }), digest);
  const ethersDigest = TypedDataEncoder.hash(
    { name: 'Ethereum Confidential UTXO', version: '1', chainId: 31337,
      verifyingContract: domain.pool },
    { OperationAuthorization: [
      { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
      { name: 'authScheme', type: 'uint8' }, { name: 'authVersion', type: 'uint8' },
    ] },
    { ...data, authScheme: 1, authVersion: 1 },
  );
  assert.equal(digest, ethersDigest);
});

test('recipient information has its own EIP-712 type and digest', () => {
  const domain = { chainId: '31337', pool: '0x1111111111111111111111111111111111111111' };
  const info = { owner: '0x2222222222222222222222222222222222222222',
    receivePublicKey: '0x' + '66'.repeat(32), receiptFormat: 1, recipientInfoVersion: 1 };
  const actual = recipientInfoParts(domain, info);
  assert.equal(actual.digest, TypedDataEncoder.hash(
    { name: 'Ethereum Confidential UTXO', version: '1', chainId: 31337,
      verifyingContract: domain.pool },
    { RecipientInfo: [
      { name: 'owner', type: 'address' }, { name: 'receivePublicKey', type: 'bytes32' },
      { name: 'receiptFormat', type: 'uint8' },
      { name: 'recipientInfoVersion', type: 'uint8' },
    ] },
    info,
  ));
  assert.notEqual(actual.digest, authorizationDigest(domain, {
    operationId: '0x' + '66'.repeat(32), owner: info.owner,
  }));
});

test('generator writes operation shapes and signature cases to a separate directory', () => {
  const output = mkdtempSync(join(tmpdir(), 'ecu-abi-vectors-'));
  try {
    const run = spawnSync(process.execPath,
      ['tests/vectors/tools/oracle-abi.mjs', '--out', output],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const operations = JSON.parse(readFileSync(join(output, 'operation.json'), 'utf8'));
    const rejected = JSON.parse(readFileSync(join(output, 'operation-rejected.json'), 'utf8'));
    const authorizations = JSON.parse(readFileSync(join(output, 'authorization.json'), 'utf8'));
    assert.deepEqual(operations.map(item => item.id), [
      'VEC-01-DEPOSIT', 'VEC-01-TRANSFER-ONE', 'VEC-01-TRANSFER-CHANGE',
      'VEC-01-TRANSFER-MERGE', 'VEC-01-TRANSFER-SELF',
      'VEC-01-WITHDRAW-FULL', 'VEC-01-WITHDRAW-PARTIAL', 'VEC-01-WITHDRAW-SELF',
    ]);
    assert.equal(operations[0].expected.operationId,
      ethersKeccak(operations[0].expected.operationPreimage));
    assert.ok(authorizations.some(item => item.id === 'VEC-02-OPERATION-SIGNATURE'));
    assert.ok(authorizations.some(item => item.id === 'VEC-02-RECIPIENT-SIGNATURE'));
    assert.deepEqual(rejected.map(item => item.mutatedField), [
      'inputIds.order', 'inputIds.duplicate', 'kind', 'outputs[0].receiptFormat',
      'outputs[0].packet.length', 'w', 'd', 'destination',
      'outputs[0].owner', 'destination',
    ]);
    assert.ok(authorizations.some(item => item.id === 'VEC-02-HIGH-S'));
    assert.ok(authorizations.some(item => item.id === 'VEC-02-CHAIN-CHANGED'));
    assert.ok(authorizations.some(item => item.id === 'VEC-02-RECIPIENT-KEY-CHANGED'));
    assert.ok(rejected.every(item => item.expected.decision === 'reject'));
    assert.equal(rejected.find(item => item.id === 'VEC-01-ZERO-DEPOSIT').expected.reason,
      'PublicAmountOutOfRange');
    const independent = spawnSync(process.execPath,
      ['tests/vectors/tools/verify-abi.mjs', output], { encoding: 'utf8' });
    assert.equal(independent.status, 0, independent.stderr);
    const falseReject = authorizations.map(item => ({ ...item, input: { ...item.input } }));
    falseReject.find(item => item.id === 'VEC-02-CHAIN-CHANGED').input.chainId = '31337';
    writeFileSync(join(output, 'authorization.json'), JSON.stringify(falseReject));
    const falseRejectRun = spawnSync(process.execPath,
      ['tests/vectors/tools/verify-abi.mjs', output], { encoding: 'utf8' });
    assert.notEqual(falseRejectRun.status, 0, 'independent verifier must reject a false rejection claim');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('authorization corpus appends signer, cross-use, scalar-boundary and recovery cases', () => {
  const cases = JSON.parse(readFileSync('tests/vectors/cases/authorization.json', 'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(cases.slice(0, 13))).digest('hex'),
    '6ee86470d92b649e65f8cfe22760e18f01069274ed986235c46b4c33e9a9f359');
  assert.deepEqual(cases.slice(13).map(item => item.id), [
    'VEC-02-WRONG-SIGNER', 'VEC-02-RECIPIENT-WRONG-SIGNER',
    'VEC-02-OPERATION-SIG-AS-RECIPIENT', 'VEC-02-RECIPIENT-SIG-AS-OPERATION',
    'VEC-02-R-AT-ORDER', 'VEC-02-S-AT-ORDER',
    'VEC-02-ZERO-OWNER', 'VEC-02-RECOVERY-FAILURE',
  ]);
  assert.deepEqual(cases.slice(13).map(item => item.stage), [
    'signature-signer', 'signature-signer', 'signature-cross-use',
    'signature-cross-use', 'signature-format', 'signature-format',
    'signature-owner', 'signature-recovery',
  ]);
  assert.ok(cases.slice(13).every(item => item.expected.decision === 'reject'));
  const wrong = cases.find(item => item.id === 'VEC-02-WRONG-SIGNER');
  const base = cases.find(item => item.id === 'VEC-02-OPERATION-SIGNATURE');
  assert.equal(wrong.input.operationId, base.input.operationId);
  assert.equal(wrong.input.owner, base.input.owner);
  assert.notEqual(recoverAddress(base.expected.digest, wrong.input.signature).toLowerCase(),
    base.input.owner);
  const rOrder = cases.find(item => item.id === 'VEC-02-R-AT-ORDER');
  const sOrder = cases.find(item => item.id === 'VEC-02-S-AT-ORDER');
  const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  assert.equal(BigInt('0x' + rOrder.input.signature.slice(2, 66)), order);
  assert.equal(BigInt('0x' + sOrder.input.signature.slice(66, 130)), order);
  const recovery = cases.find(item => item.id === 'VEC-02-RECOVERY-FAILURE');
  assert.throws(() => recoverAddress(base.expected.digest, recovery.input.signature),
    /square root/);
});
