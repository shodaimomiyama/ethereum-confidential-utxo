import { createHash, createHmac, createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519.js';
import { bn254 } from '@noble/curves/bn254.js';
import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { Wallet } from 'ethers';
import { encodeAbiParameters, parseAbiParameters, keccak256, stringToHex } from 'viem';
import { buildOperation, authorizationDigest, recipientInfoParts, buildOperationLogs } from './oracle-abi.mjs';

const b = hex => Buffer.from(hex.slice(2), 'hex');
const hex = bytes => '0x' + Buffer.from(bytes).toString('hex');
const word = value => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
const u16 = value => Buffer.from([(value >> 8) & 255, value & 255]);
const KEM = Buffer.concat([Buffer.from('KEM'), u16(32)]);
const SUITE = Buffer.concat([Buffer.from('HPKE'), u16(32), u16(1), u16(3)]);
const sha = value => createHash('sha256').update(value).digest();
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const extract = (salt, ikm) => hmac(salt.length ? salt : Buffer.alloc(32), ikm);
function expand(prk, info, length) {
  const blocks = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
const labeledExtract = (suite, salt, label, ikm) =>
  extract(salt, Buffer.concat([Buffer.from('HPKE-v1'), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, Buffer.concat([u16(length), Buffer.from('HPKE-v1'), suite,
    Buffer.from(label), info]), length);

export function deriveKeyPair(ikm) {
  const prk = labeledExtract(KEM, Buffer.alloc(0), 'dkp_prk', b(ikm));
  const privateKey = labeledExpand(KEM, prk, 'sk', Buffer.alloc(0), 32);
  return { privateKey: hex(privateKey), publicKey: hex(x25519.getPublicKey(privateKey)) };
}

export function sealFixed({ recipientPublicKey, ikmE, info, plaintext, aad = '0x' }) {
  const ephemeral = deriveKeyPair(ikmE);
  const enc = b(ephemeral.publicKey);
  const sharedDH = Buffer.from(x25519.getSharedSecret(b(ephemeral.privateKey), b(recipientPublicKey)));
  const eae = labeledExtract(KEM, Buffer.alloc(0), 'eae_prk', sharedDH);
  const sharedSecret = labeledExpand(KEM, eae, 'shared_secret',
    Buffer.concat([enc, b(recipientPublicKey)]), 32);
  const pskIdHash = labeledExtract(SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0));
  const infoHash = labeledExtract(SUITE, Buffer.alloc(0), 'info_hash', b(info));
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]);
  const secret = labeledExtract(SUITE, sharedSecret, 'secret', Buffer.alloc(0));
  const key = labeledExpand(SUITE, secret, 'key', context, 32);
  const nonce = labeledExpand(SUITE, secret, 'base_nonce', context, 12);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(b(aad));
  const ciphertext = Buffer.concat([cipher.update(b(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return { enc: hex(enc), ciphertext: hex(ciphertext), packet: hex(Buffer.concat([enc, ciphertext])),
    ephemeralPrivateKey: ephemeral.privateKey, sharedSecret: hex(sharedSecret), key: hex(key), nonce: hex(nonce) };
}

const q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const M = 1n << 64n;
const parameters = JSON.parse(readFileSync(new URL('../../../experiments/design/crypto-profile-v3/exp08/parameters.json', import.meta.url), 'utf8'));
const H = bn254.G1.Point.fromAffine({ x: BigInt(parameters.base[0]), y: BigInt(parameters.base[1]) });
const G = bn254.G1.Point.fromAffine({ x: BigInt(parameters.base[2]), y: BigInt(parameters.base[3]) });
function commitment(value, blinding) {
  const point = H.multiply(BigInt(value)).add(blinding === 0n ? bn254.G1.Point.ZERO : G.multiply(blinding));
  const affine = point.toAffine();
  return { Cx: String(affine.x), Cy: String(affine.y) };
}

const PARAMETERS_HASH = '0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae';
const BALANCE_TAG = keccak256(stringToHex('ecu/balance-schnorr/bn254/v1'));
const balanceChallengeTypes = parseAbiParameters(
  'bytes32, uint256, address, bytes32, bytes32, uint256, uint256, uint256, uint256, uint256, uint256, uint256');

export function zeroBalanceProof(operationInput, operationId, inputContext = []) {
  if (inputContext.length !== operationInput.inputIds.length ||
      inputContext.some((item, index) => item.inputId !== operationInput.inputIds[index])) {
    throw new Error('input commitments do not match input IDs');
  }
  let X = bn254.G1.Point.ZERO;
  for (const item of inputContext) {
    const C = bn254.G1.Point.fromAffine({ x: BigInt(item.Cx), y: BigInt(item.Cy) });
    X = X.add(C);
  }
  if (BigInt(operationInput.d) > 0n) X = X.add(H.multiply(BigInt(operationInput.d)));
  for (const output of operationInput.outputs) {
    const C = bn254.G1.Point.fromAffine({ x: BigInt(output.Cx), y: BigInt(output.Cy) });
    X = X.subtract(C);
  }
  if (BigInt(operationInput.w) > 0n) X = X.subtract(H.multiply(BigInt(operationInput.w)));
  if (!X.equals(bn254.G1.Point.ZERO)) {
    throw new Error('deposit witness has nonzero balance difference');
  }
  const R = parameters.base.slice(2);
  const challengeTrace = [];
  for (let counter = 0; counter < 256; counter++) {
    const preimage = encodeAbiParameters(balanceChallengeTypes,
      [BALANCE_TAG, BigInt(operationInput.chainId), operationInput.pool, PARAMETERS_HASH,
        operationId, BigInt(R[0]), BigInt(R[1]), 0n, 0n,
        BigInt(R[0]), BigInt(R[1]), BigInt(counter)]);
    const candidate = BigInt(keccak256(preimage));
    const accepted = candidate >= 1n && candidate < q;
    challengeTrace.push({ counter: String(counter), preimage,
      candidate: String(candidate), accepted });
    if (accepted) {
      return { parametersHash: PARAMETERS_HASH, X: ['0', '0'], R, s: '1',
        encoded: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256'),
          [BigInt(R[0]), BigInt(R[1]), 1n]),
        acceptedCounter: String(counter), challenge: String(candidate),
        challengeTrace, equationHolds: true };
    }
  }
  throw new Error('256 balance challenge candidates exhausted');
}

export const depositBalanceProof = zeroBalanceProof;

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
export async function validateReceipt(input, packet) {
  if (b(packet).length !== 112) return { decision: 'reject', stage: 'pool-packet' };
  if (b(input.info).length !== 32) return { decision: 'reject', stage: 'receipt-decrypt' };
  let plaintext;
  try {
    const privateKey = await suite.kem.deserializePrivateKey(b(input.recipientPrivateKey));
    const context = await suite.createRecipientContext({ recipientKey: privateKey,
      enc: b(packet).subarray(0, 32), info: b(input.info) });
    plaintext = Buffer.from(await context.open(b(packet).subarray(32), b(input.aad)));
  } catch {
    return { decision: 'reject', stage: 'receipt-decrypt' };
  }
  if (plaintext.length !== 64) return { decision: 'reject', stage: 'receipt-decrypt' };
  const value = BigInt(hex(plaintext.subarray(0, 32)));
  const blinding = BigInt(hex(plaintext.subarray(32)));
  if (value < 1n || value > M) return { decision: 'reject', stage: 'receipt-value' };
  if (blinding >= q) return { decision: 'reject', stage: 'receipt-blinding' };
  if (input.expectedOwner.toLowerCase() !== input.outputOwner.toLowerCase()) {
    return { decision: 'reject', stage: 'receipt-owner' };
  }
  const expected = commitment(value, blinding);
  if (expected.Cx !== input.Cx || expected.Cy !== input.Cy) {
    return { decision: 'reject', stage: 'receipt-commitment' };
  }
  return { decision: 'accept', stage: 'receipt', value: String(value), blinding: String(blinding) };
}

const entry = (id, stage, input, expected, source = 'docs/design.md#d-08-暗号化受領データと出力イベント') => ({
  id: `VEC-07-${id}`, profile: 'hpke-receipt-v1', source, stage, input, expected,
  oracle: 'RFC 9180 labeled HKDF; Node 24 ChaCha20-Poly1305; @hpke/core 1.9.0 independent decryption',
  consumers: ['#28', '#29', '#30'],
});

async function makeApplicationCase(name, operationInput, ownerWallet, inputContext,
    receipts, rangeProofStatus) {
  const result = buildOperation(operationInput);
  const owner = ownerWallet.address.toLowerCase();
  const digest = authorizationDigest({ chainId: operationInput.chainId, pool: operationInput.pool },
    { operationId: result.operationId, owner });
  const signature = await ownerWallet.signTypedData({ name: 'Ethereum Confidential UTXO',
    version: '1', chainId: Number(operationInput.chainId),
    verifyingContract: operationInput.pool },
  { OperationAuthorization: [
    { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
    { name: 'authScheme', type: 'uint8' }, { name: 'authVersion', type: 'uint8' },
  ] }, { operationId: result.operationId, owner, authScheme: 1, authVersion: 1 });
  return entry(`APPLICATION-${name}`, 'application-operation', operationInput,
    { ...result, authorizationDigest: digest, authorizationSignature: signature,
      inputContext, balanceProof: zeroBalanceProof(operationInput, result.operationId, inputContext),
      rangeProofs: [], rangeProofStatus,
      logs: buildOperationLogs({ input: operationInput, expected: result }), receipts },
    'docs/design.md#操作の結合とabi');
}

async function signReceiptInfo(receipt, wallet, chainId, pool) {
  const recipient = { owner: wallet.address.toLowerCase(),
    receivePublicKey: receipt.recipientPublicKey, receiptFormat: 1,
    recipientInfoVersion: 1 };
  if (recipient.owner !== receipt.outputOwner) throw new Error('recipient owner mismatch');
  const digest = recipientInfoParts({ chainId, pool }, recipient).digest;
  const signature = await wallet.signTypedData({ name: 'Ethereum Confidential UTXO',
    version: '1', chainId: Number(chainId), verifyingContract: pool },
  { RecipientInfo: [
    { name: 'owner', type: 'address' }, { name: 'receivePublicKey', type: 'bytes32' },
    { name: 'receiptFormat', type: 'uint8' },
    { name: 'recipientInfoVersion', type: 'uint8' },
  ] }, recipient);
  return { ...receipt, recipientInfo: { ...recipient, digest, signature } };
}

export async function generateHpkeCases() {
  const rfc = entry('RFC-A2-BASE', 'hpke-rfc', {
    recipientPrivateKey: '0x8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
    recipientPublicKey: '0x4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
    ikmE: '0x909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b',
    enc: '0x1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
    info: '0x4f6465206f6e2061204772656369616e2055726e',
    plaintext: '0x4265617574792069732074727574682c20747275746820626561757479',
    aad: '0x436f756e742d30',
  }, {
    enc: '0x1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
    ciphertext: '0x1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
  }, 'https://www.rfc-editor.org/rfc/rfc9180.html#appendix-A.2.1');
  const rfcSeal = sealFixed({ recipientPublicKey: rfc.input.recipientPublicKey,
    ikmE: rfc.input.ikmE, info: rfc.input.info,
    plaintext: rfc.input.plaintext, aad: rfc.input.aad });
  if (rfcSeal.enc !== rfc.expected.enc || rfcSeal.ciphertext !== rfc.expected.ciphertext ||
      deriveKeyPair(rfc.input.ikmE).privateKey !==
      '0xf4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600') {
    throw new Error('RFC 9180 A.2.1 mismatch');
  }
  const ikmR = hex(sha(Buffer.from('ecu/vectors/receipt-recipient/v1')));
  const recipient = deriveKeyPair(ikmR);
  const ownerWallet = new Wallet('0x' + '01'.repeat(32));
  const owner = ownerWallet.address.toLowerCase();
  const seed = { chainId: '31337', pool: '0x1111111111111111111111111111111111111111',
    kind: 0, owner, salt: '0x' + 'a7'.repeat(32), inputIds: [],
    d: '1', w: '0', destination: '0x0000000000000000000000000000000000000000',
    outputs: [{ owner, ...commitment(1n, 0n), receiptFormat: 1,
      packet: '0x' + '00'.repeat(112) }] };
  const info = buildOperation(seed).info[0].hash;
  const ikmE = hex(sha(Buffer.from('ecu/vectors/receipt-ephemeral/valid/v1')));
  const plaintext = hex(Buffer.concat([word(1n), word(0n)]));
  const sealed = sealFixed({ recipientPublicKey: recipient.publicKey, ikmE, info, plaintext });
  const input = { info, aad: '0x', plaintext, recipientPrivateKey: recipient.privateKey,
    recipientPublicKey: recipient.publicKey, ikmR, ikmE, expectedOwner: owner,
    outputOwner: owner, Cx: seed.outputs[0].Cx, Cy: seed.outputs[0].Cy,
    packet: sealed.packet };
  const normal = entry('RECEIPT-VALID', 'receipt', input,
    { decision: 'accept', ...sealed, value: '1', blinding: '0' });
  const rejection = (label, stage, change, mutatedField, packet = sealed.packet) => ({
    ...entry(label, stage, { ...input, ...change, packet }, { decision: 'reject', stage }),
    baseCase: normal.id, mutatedField,
  });
  const flip = (packet, byteIndex) => {
    const copy = b(packet); copy[byteIndex] ^= 1; return hex(copy);
  };
  const invalid = [
    rejection('SHORT-PACKET', 'pool-packet', {}, 'packet.length', hex(b(sealed.packet).subarray(0, 111))),
    rejection('LONG-PACKET', 'pool-packet', {}, 'packet.length', hex(Buffer.concat([b(sealed.packet), Buffer.alloc(1)]))),
    rejection('WRONG-KEY', 'receipt-decrypt', { recipientPrivateKey: deriveKeyPair(hex(sha(Buffer.from('ecu/vectors/wrong-key')))).privateKey }, 'recipientPrivateKey'),
    rejection('ENC-CHANGED', 'receipt-decrypt', {}, 'packet.enc', flip(sealed.packet, 0)),
    rejection('CIPHERTEXT-CHANGED', 'receipt-decrypt', {}, 'packet.ciphertext', flip(sealed.packet, 33)),
    rejection('INFO-CHANGED', 'receipt-decrypt', { info: flip(info, 0) }, 'info'),
    rejection('OWNER-CHANGED', 'receipt-owner', { expectedOwner: '0x3333333333333333333333333333333333333333' }, 'expectedOwner'),
    rejection('COMMITMENT-CHANGED', 'receipt-commitment', { Cx: '1', Cy: '2' }, 'Cx'),
  ];
  for (const [label, value, blinding, stage, field] of [
    ['ZERO-V', 0n, 0n, 'receipt-value', 'plaintext.v'],
    ['V-OVER-M', M + 1n, 0n, 'receipt-value', 'plaintext.v'],
    ['R-Q', 1n, q, 'receipt-blinding', 'plaintext.r'],
  ]) {
    const variantIkmE = hex(sha(Buffer.from(`ecu/vectors/receipt-ephemeral/${label}/v1`)));
    const variantPlaintext = hex(Buffer.concat([word(value), word(blinding)]));
    const variant = sealFixed({ recipientPublicKey: recipient.publicKey,
      ikmE: variantIkmE, info, plaintext: variantPlaintext });
    invalid.push(rejection(label, stage, { ikmE: variantIkmE, plaintext: variantPlaintext },
      field, variant.packet));
  }
  const operationInput = { ...seed, outputs: [{ ...seed.outputs[0], packet: sealed.packet }] };
  const depositReceipt = await signReceiptInfo({ ...input, outputIndex: 0,
    value: '1', blinding: '0' }, ownerWallet, seed.chainId, seed.pool);
  const deposit = await makeApplicationCase('DEPOSIT', operationInput, ownerWallet, [],
    [depositReceipt], 'not-required-for-deposit');

  const recipientWallet = new Wallet('0x' + '02'.repeat(32));
  const recipientOwner = recipientWallet.address.toLowerCase();
  const recipientIkmR = hex(sha(Buffer.from('ecu/vectors/receipt-recipient/transfer/v1')));
  const recipientKey = deriveKeyPair(recipientIkmR);
  const transferInputId = '0x' + '10'.repeat(32);
  const transferSeed = { ...seed, kind: 1, salt: '0x' + 'a8'.repeat(32),
    inputIds: [transferInputId], d: '0',
    outputs: [
      { owner: recipientOwner, ...commitment(1n, 0n), receiptFormat: 1,
        packet: '0x' + '00'.repeat(112) },
      { owner, ...commitment(1n, 0n), receiptFormat: 1,
        packet: '0x' + '00'.repeat(112) },
    ] };
  const transferInfos = buildOperation(transferSeed).info.map(item => item.hash);
  const transferRecipients = [recipientKey, recipient];
  const transferIkms = [recipientIkmR, ikmR];
  const unsignedTransferReceipts = transferSeed.outputs.map((output, outputIndex) => {
    const key = transferRecipients[outputIndex];
    const outputIkmE = hex(sha(Buffer.from(`ecu/vectors/receipt-ephemeral/transfer-${outputIndex}/v1`)));
    const packet = sealFixed({ recipientPublicKey: key.publicKey,
      ikmE: outputIkmE, info: transferInfos[outputIndex], plaintext });
    transferSeed.outputs[outputIndex].packet = packet.packet;
    return { outputIndex, info: transferInfos[outputIndex], aad: '0x', plaintext,
      recipientPrivateKey: key.privateKey, recipientPublicKey: key.publicKey,
      ikmR: transferIkms[outputIndex], ikmE: outputIkmE, expectedOwner: output.owner,
      outputOwner: output.owner, Cx: output.Cx, Cy: output.Cy,
      packet: packet.packet, value: '1', blinding: '0' };
  });
  const transferReceipts = await Promise.all(unsignedTransferReceipts.map((receipt, index) =>
    signReceiptInfo(receipt, index === 0 ? recipientWallet : ownerWallet,
      seed.chainId, seed.pool)));
  const transferInputContext = [{ inputId: transferInputId, owner,
    ...commitment(2n, 0n), amount: '2', blinding: '0', status: 1,
    source: 'pre-existing test-only UTXO state' }];
  const transfer = await makeApplicationCase('TRANSFER-CHANGE', transferSeed,
    ownerWallet, transferInputContext, transferReceipts, 'pending-v3-two-outputs');

  const withdrawalInputId = transfer.expected.outputIds[1].hash;
  const withdrawalInput = { ...seed, kind: 2, salt: '0x' + 'a9'.repeat(32),
    inputIds: [withdrawalInputId], outputs: [], d: '0', w: '1',
    destination: recipientOwner };
  const withdrawalContext = [{ inputId: withdrawalInputId, owner,
    ...commitment(1n, 0n), amount: '1', blinding: '0', status: 1,
    source: transfer.id }];
  const withdrawal = await makeApplicationCase('WITHDRAW-FULL', withdrawalInput,
    ownerWallet, withdrawalContext, [], 'not-required-with-zero-outputs');
  return { hpke: [rfc, normal, ...invalid],
    application: [deposit, transfer, withdrawal] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--out' || !process.argv[3] || process.argv.length !== 4) {
    throw new Error('Usage: node oracle-hpke.mjs --out <directory>');
  }
  const output = resolve(process.argv[3]);
  mkdirSync(output, { recursive: true });
  const cases = await generateHpkeCases();
  writeFileSync(join(output, 'hpke.json'), JSON.stringify(cases.hpke, null, 2) + '\n');
  writeFileSync(join(output, 'application-operation.json'), JSON.stringify(cases.application, null, 2) + '\n');
}
