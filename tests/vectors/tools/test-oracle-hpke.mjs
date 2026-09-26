import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { AbiCoder, id, keccak256 as ethersKeccak, recoverAddress } from 'ethers';
import { bn254 } from '@noble/curves/bn254.js';
import { buildOperation } from './oracle-abi.mjs';
import { generateHpkeCases, validateReceipt } from './oracle-hpke.mjs';

const root = new URL('../cases/', import.meta.url);
const hpke = JSON.parse(readFileSync(new URL('hpke.json', root), 'utf8'));
const application = JSON.parse(readFileSync(new URL('application-operation.json', root), 'utf8'));
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const bytes = hex => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
const find = id => hpke.find(item => item.id === id);

test('RFC 9180 A.2.1 base mode known ciphertext decrypts', async () => {
  const entry = find('VEC-07-RFC-A2-BASE');
  const privateKey = await suite.kem.deserializePrivateKey(bytes(entry.input.recipientPrivateKey));
  const context = await suite.createRecipientContext({ recipientKey: privateKey,
    enc: bytes(entry.input.enc), info: bytes(entry.input.info) });
  const plaintext = await context.open(bytes(entry.expected.ciphertext), bytes(entry.input.aad));
  assert.equal('0x' + Buffer.from(plaintext).toString('hex'), entry.input.plaintext);
  assert.equal(entry.expected.enc, entry.input.enc);
  assert.equal(entry.expected.ciphertext,
    '0x1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28');
});

test('fixed application packet derives info before operation ID', async () => {
  const generated = await generateHpkeCases();
  assert.deepEqual(generated.hpke, hpke);
  assert.deepEqual(generated.application, application);
  const normal = find('VEC-07-RECEIPT-VALID');
  const { input, expected } = normal;
  assert.equal(bytes(input.info).length, 32);
  assert.equal(input.aad, '0x');
  assert.equal(bytes(input.plaintext).length, 64);
  assert.equal(bytes(expected.enc).length, 32);
  assert.equal(bytes(expected.ciphertext).length, 80);
  assert.equal(bytes(expected.packet).length, 112);
  assert.equal(expected.decision, 'accept');
  assert.equal((await validateReceipt(input, expected.packet)).decision, 'accept');
  const op = application[0];
  assert.equal(buildOperation(op.input).operationId, op.expected.operationId);
  assert.equal(op.input.outputs[0].packet, expected.packet);
  assert.equal(buildOperation(op.input).info[0].hash, input.info);
  assert.equal(recoverAddress(op.expected.authorizationDigest,
    op.expected.authorizationSignature).toLowerCase(), op.input.owner);
  assert.equal(op.expected.logs.at(-1).topics[1], op.expected.operationId);
});

test('cryptographic and post-decryption failures are distinct', async () => {
  for (const entry of hpke.filter(item => item.expected.decision === 'reject')) {
    const actual = await validateReceipt(entry.input, entry.input.packet);
    assert.equal(actual.decision, 'reject', entry.id);
    assert.equal(actual.stage, entry.stage, entry.id);
  }
  assert.equal(find('VEC-07-SHORT-PACKET').stage, 'pool-packet');
  assert.equal(find('VEC-07-ZERO-V').stage, 'receipt-value');
  assert.equal(find('VEC-07-R-Q').stage, 'receipt-blinding');
  assert.equal(find('VEC-07-OWNER-CHANGED').stage, 'receipt-owner');
  assert.equal(find('VEC-07-COMMITMENT-CHANGED').stage, 'receipt-commitment');
});

test('application deposit has a valid balance proof for the same operation ID', () => {
  const op = application[0];
  const proof = op.expected.balanceProof;
  const params = JSON.parse(readFileSync(new URL('../../../experiments/design/crypto-profile-v3/exp08/parameters.json', import.meta.url), 'utf8'));
  const H = bn254.G1.Point.fromAffine({ x: BigInt(params.base[0]), y: BigInt(params.base[1]) });
  const G = bn254.G1.Point.fromAffine({ x: BigInt(params.base[2]), y: BigInt(params.base[3]) });
  const output = op.input.outputs[0];
  const C = bn254.G1.Point.fromAffine({ x: BigInt(output.Cx), y: BigInt(output.Cy) });
  const X = H.multiply(BigInt(op.input.d)).subtract(C);
  assert.equal(X.equals(bn254.G1.Point.ZERO), true);
  assert.deepEqual(proof.X, ['0', '0']);
  assert.deepEqual(proof.R, params.base.slice(2));
  assert.equal(proof.s, '1');
  assert.deepEqual(op.expected.rangeProofs, []);
  const abi = AbiCoder.defaultAbiCoder();
  assert.equal(proof.encoded,
    abi.encode(['uint256', 'uint256', 'uint256'], [...proof.R, proof.s]));
  const order = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
  for (const [index, step] of proof.challengeTrace.entries()) {
    assert.equal(Number(step.counter), index);
    const preimage = abi.encode(
      ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32',
        'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      [id('ecu/balance-schnorr/bn254/v1'), op.input.chainId, op.input.pool,
        proof.parametersHash, op.expected.operationId,
        params.base[2], params.base[3], '0', '0', ...proof.R, step.counter]);
    assert.equal(step.preimage, preimage);
    assert.equal(step.candidate, BigInt(ethersKeccak(preimage)).toString());
    assert.equal(step.accepted, 1n <= BigInt(step.candidate) && BigInt(step.candidate) < order);
    if (index < proof.challengeTrace.length - 1) assert.equal(step.accepted, false);
  }
  const last = proof.challengeTrace.at(-1);
  assert.equal(last.accepted, true);
  assert.equal(proof.challenge, last.candidate);
  assert.equal(proof.acceptedCounter, last.counter);
  assert.equal(G.multiply(BigInt(proof.s)).equals(
    G.add(X.multiply(BigInt(proof.challenge)))), true);
});
