import { AbiCoder, getAddress, hashMessage, keccak256, recoverAddress, sha256, toUtf8Bytes } from 'ethers';
import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js';

const POOL = '0x0000000000000000000000000000000000000001';
const Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const M = 1n << 64n;
const U8 = (hex) => Uint8Array.from(hex.slice(2).match(/../g), (v) => parseInt(v, 16));
const HEX = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const SUITE = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Chacha20Poly1305 });
const ABI = AbiCoder.defaultAbiCoder();
const HKDF_SALT = U8(sha256(toUtf8Bytes('ecu/uniswap/key-root/hkdf-salt/v1')));
const HKDF_INFO = toUtf8Bytes('ecu/uniswap/recipient-ikm/v1');
const INFO_TAG = keccak256(toUtf8Bytes('ecu/hpke-info/v1'));

export function messageFor(owner, chainId) {
  return [
    'ECU Uniswap recipient-key reproducibility probe v1',
    'This signature is secret key material. Never share it.',
    'Purpose: ecu/uniswap/key-root/v1',
    `ChainId: ${BigInt(chainId).toString(10)}`,
    `Pool: ${POOL}`,
    `Owner: ${getAddress(owner).toLowerCase()}`,
  ].join('\n');
}

function canonicalSignature(signature, message, owner) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid signature length or encoding');
  const bytes = U8(signature);
  if (bytes[64] !== 27 && bytes[64] !== 28) throw new Error('Noncanonical recovery byte');
  const s = BigInt(`0x${HEX(bytes.slice(32, 64)).slice(2)}`);
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  if (s < 1n || s > n / 2n) throw new Error('Noncanonical signature s');
  if (recoverAddress(hashMessage(toUtf8Bytes(message)), signature) !== getAddress(owner)) throw new Error('Signature owner mismatch');
  return bytes;
}

export async function recipientFromSignature(owner, chainId, signature) {
  const message = messageFor(owner, chainId);
  const bytes = canonicalSignature(signature, message, owner);
  let ikm;
  try {
    const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
    ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO }, base, 256));
    const keyPair = await SUITE.kem.deriveKeyPair(ikm);
    const publicKey = new Uint8Array(await SUITE.kem.serializePublicKey(keyPair.publicKey));
    if (publicKey.length !== 32) throw new Error('Unexpected recipient public key');
    return { keyPair, publicKey: HEX(publicKey) };
  } finally {
    bytes.fill(0);
    ikm?.fill(0);
  }
}

function boundedRandom(maxExclusive, byteLength) {
  for (;;) {
    const raw = crypto.getRandomValues(new Uint8Array(byteLength));
    const value = BigInt(HEX(raw));
    raw.fill(0);
    if (value < maxExclusive) return value;
  }
}

function encode32(value) {
  return U8(`0x${value.toString(16).padStart(64, '0')}`);
}

function infoFor(chainId, owner, salt) {
  return U8(keccak256(ABI.encode(
    ['bytes32', 'uint256', 'address', 'uint8', 'bytes32', 'uint256', 'address', 'uint256', 'uint256', 'uint8'],
    [INFO_TAG, BigInt(chainId), POOL, 1, salt, 0, owner, 1, 2, 1],
  )));
}

export async function createEnvelope(owner, chainId, recipient) {
  const salt = HEX(crypto.getRandomValues(new Uint8Array(32)));
  const info = infoFor(chainId, owner, salt);
  const v = boundedRandom(M, 8) + 1n;
  const r = boundedRandom(Q, 32);
  const plaintext = new Uint8Array(64);
  plaintext.set(encode32(v));
  plaintext.set(encode32(r), 32);
  try {
    const { enc, ct } = await SUITE.seal({ recipientPublicKey: recipient.keyPair.publicKey, info }, plaintext, new Uint8Array());
    const packet = new Uint8Array(112);
    if (enc.byteLength !== 32 || ct.byteLength !== 80) throw new Error('Unexpected HPKE length');
    packet.set(new Uint8Array(enc));
    packet.set(new Uint8Array(ct), 32);
    return { format: 1, owner: getAddress(owner).toLowerCase(), chainId: BigInt(chainId).toString(10), pool: POOL, recipientPublicKey: recipient.publicKey, kind: 1, salt, outputIndex: 0, Cx: '1', Cy: '2', packet: HEX(packet) };
  } finally {
    plaintext.fill(0);
  }
}

export async function openEnvelope(envelope, owner, chainId, recipient) {
  if (envelope?.format !== 1 || envelope?.owner !== getAddress(owner).toLowerCase() || envelope?.chainId !== BigInt(chainId).toString(10) || envelope?.pool !== POOL || envelope?.recipientPublicKey !== recipient.publicKey || envelope?.kind !== 1 || envelope?.outputIndex !== 0 || envelope?.Cx !== '1' || envelope?.Cy !== '2') throw new Error('Public context or recipient key mismatch');
  if (!/^0x[0-9a-fA-F]{64}$/.test(envelope.salt) || !/^0x[0-9a-fA-F]{224}$/.test(envelope.packet)) throw new Error('Invalid public envelope encoding');
  const packet = U8(envelope.packet);
  const info = infoFor(chainId, owner, envelope.salt);
  const plaintext = new Uint8Array(await SUITE.open({ recipientKey: recipient.keyPair.privateKey, enc: packet.slice(0, 32), info }, packet.slice(32), new Uint8Array()));
  try {
    if (plaintext.length !== 64) throw new Error('Invalid plaintext length');
    const v = BigInt(HEX(plaintext.slice(0, 32)));
    const r = BigInt(HEX(plaintext.slice(32)));
    if (v < 1n || v > M || r >= Q) throw new Error('Invalid receipt scalar range');
  } finally {
    plaintext.fill(0);
  }
  packet[111] ^= 1;
  let tamperingRejected = false;
  try {
    await SUITE.open({ recipientKey: recipient.keyPair.privateKey, enc: packet.slice(0, 32), info }, packet.slice(32), new Uint8Array());
  } catch {
    tamperingRejected = true;
  }
  if (!tamperingRejected) throw new Error('Tampered packet accepted');
  return { recipientPublicKey: recipient.publicKey, packetBytes: 112, decryptedFormatAndRangeValid: true, tamperingRejected: true, commitmentAndHistoryChecked: false };
}
