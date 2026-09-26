"use strict";

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AbiCoder, TypedDataEncoder, id, keccak256, recoverAddress } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const encoded = (types, values) => coder.encode(types, values).toLowerCase();
const hash = (types, values) => {
  const preimage = encoded(types, values);
  return { preimage, hash: keccak256(preimage) };
};
const TAG = {
  info: id('ecu/hpke-info/v1'), input: id('ecu/inputs/v1'),
  output: id('ecu/output/v1'), outputs: id('ecu/outputs/v1'),
  operation: id('ecu/operation/v1'), outputId: id('ecu/output-id/v1'),
};

function verifyOperation(caseData) {
  const input = caseData.input;
  const expected = caseData.expected;
  const chainId = BigInt(input.chainId);
  const inputs = hash(['bytes32', 'bytes32[]'], [TAG.input, input.inputIds]);
  assert.deepEqual(expected.inputIdsHash, inputs, caseData.id);
  const perOutput = input.outputs.map((output, index) => {
    const info = hash(
      ['bytes32', 'uint256', 'address', 'uint8', 'bytes32', 'uint256', 'address', 'uint256', 'uint256', 'uint8'],
      [TAG.info, chainId, input.pool, input.kind, input.salt, index, output.owner,
        output.Cx, output.Cy, output.receiptFormat],
    );
    const packetHash = keccak256(output.packet);
    const outputHash = hash(
      ['bytes32', 'uint256', 'address', 'uint256', 'uint256', 'uint8', 'bytes32'],
      [TAG.output, index, output.owner, output.Cx, output.Cy,
        output.receiptFormat, packetHash],
    );
    return { info, packetHash, outputHash };
  });
  assert.deepEqual(expected.info, perOutput.map(item => item.info), caseData.id);
  assert.deepEqual(expected.packetHashes, perOutput.map(item => item.packetHash), caseData.id);
  assert.deepEqual(expected.outputHashes, perOutput.map(item => item.outputHash), caseData.id);
  const outputs = hash(['bytes32', 'bytes32[]'],
    [TAG.outputs, perOutput.map(item => item.outputHash.hash)]);
  assert.deepEqual(expected.outputsHash, outputs, caseData.id);
  const operation = hash(
    ['bytes32', 'uint256', 'address', 'uint8', 'address', 'bytes32', 'bytes32',
      'bytes32', 'uint256', 'uint256', 'address'],
    [TAG.operation, chainId, input.pool, input.kind, input.owner, input.salt,
      inputs.hash, outputs.hash, input.d, input.w, input.destination],
  );
  assert.equal(expected.operationId, operation.hash, caseData.id);
  assert.equal(expected.operationPreimage, operation.preimage, caseData.id);
  const outputIds = perOutput.map((_, index) =>
    hash(['bytes32', 'bytes32', 'uint256'], [TAG.outputId, operation.hash, index]));
  assert.deepEqual(expected.outputIds, outputIds, caseData.id);
}

function verifyAuthorization(caseData) {
  const input = caseData.input;
  const domain = { name: 'Ethereum Confidential UTXO', version: '1',
    chainId: BigInt(input.chainId), verifyingContract: input.pool };
  const operation = (caseData.baseCase ?? caseData.id) === 'VEC-02-OPERATION-SIGNATURE';
  const types = operation ? { OperationAuthorization: [
    { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
    { name: 'authScheme', type: 'uint8' }, { name: 'authVersion', type: 'uint8' },
  ] } : { RecipientInfo: [
    { name: 'owner', type: 'address' }, { name: 'receivePublicKey', type: 'bytes32' },
    { name: 'receiptFormat', type: 'uint8' },
    { name: 'recipientInfoVersion', type: 'uint8' },
  ] };
  const value = operation ? {
    operationId: input.operationId, owner: input.owner,
    authScheme: input.authScheme, authVersion: input.authVersion,
  } : {
    owner: input.owner, receivePublicKey: input.receivePublicKey,
    receiptFormat: input.receiptFormat, recipientInfoVersion: input.recipientInfoVersion,
  };
  const digest = TypedDataEncoder.hash(domain, types, value);
  const signature = input.signature;
  const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const formatValid = /^0x[0-9a-f]{130}$/.test(signature) &&
    BigInt('0x' + signature.slice(2, 66)) > 0n &&
    BigInt('0x' + signature.slice(2, 66)) < n &&
    BigInt('0x' + signature.slice(66, 130)) > 0n &&
    BigInt('0x' + signature.slice(66, 130)) <= n / 2n &&
    [27, 28].includes(Number.parseInt(signature.slice(130), 16));
  const versionValid = operation ? input.authScheme === 1 && input.authVersion === 1
    : input.receiptFormat === 1 && input.recipientInfoVersion === 1;
  let actualDecision = 'reject';
  if (formatValid && versionValid) {
    try {
      if (recoverAddress(digest, signature).toLowerCase() === input.owner.toLowerCase()) {
        actualDecision = 'accept';
      }
    } catch {
      actualDecision = 'reject';
    }
  }
  assert.equal(actualDecision, caseData.expected.decision, caseData.id);
  if (actualDecision === 'accept') {
    assert.equal(caseData.expected.domainSeparator.hash, TypedDataEncoder.hashDomain(domain), caseData.id);
    assert.equal(caseData.expected.digest, digest, caseData.id);
  }
}

const directory = resolve(process.argv[2] ?? 'tests/vectors/cases');
const operations = JSON.parse(readFileSync(join(directory, 'operation.json'), 'utf8'));
const authorization = JSON.parse(readFileSync(join(directory, 'authorization.json'), 'utf8'));
for (const caseData of operations) verifyOperation(caseData);
for (const caseData of authorization) verifyAuthorization(caseData);
console.log(`Independently checked ${operations.length} operations and ${authorization.length} authorization cases`);
