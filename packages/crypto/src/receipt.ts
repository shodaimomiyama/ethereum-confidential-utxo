import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToBigInt, concat, word } from "./bytes.js";
import { CryptoFailure } from "./errors.js";
import { commit, M, parsePoint, Q, samePoint, type G1Point, type Opening } from "./group.js";

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});
const emptyAad = new Uint8Array();
const validationScalar = new Uint8Array(32).fill(1);

export type EncryptReceiptInput = Readonly<{
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  opening: Opening;
}>;
export type DecryptReceiptInput = Readonly<{
  recipientPrivateKey: Uint8Array;
  info: Uint8Array;
  packet: Uint8Array;
  commitment: G1Point;
}>;

function encodeOpening(opening: Opening): Uint8Array {
  if (opening.amount < 1n || opening.amount > M || opening.blinding < 0n || opening.blinding >= Q) {
    throw new CryptoFailure("INPUT", "receipt.opening");
  }
  return concat(word(opening.amount), word(opening.blinding));
}

export function decodeOpening(plaintext: Uint8Array): Opening {
  if (plaintext.length !== 64) throw new CryptoFailure("PLAINTEXT", "receipt");
  const amount = bytesToBigInt(plaintext.slice(0, 32));
  const blinding = bytesToBigInt(plaintext.slice(32));
  if (amount < 1n || amount > M || blinding >= Q) {
    throw new CryptoFailure("PLAINTEXT", "receipt");
  }
  return { amount, blinding };
}

export async function encryptReceipt(input: EncryptReceiptInput): Promise<Uint8Array> {
  if (input.info.length !== 32) throw new CryptoFailure("INPUT", "receipt.info");
  if (input.recipientPublicKey.length !== 32) throw new CryptoFailure("INPUT", "receipt.key");
  const plaintext = encodeOpening(input.opening);
  let recipientPublicKey: CryptoKey;
  try {
    // The fixed scalar is used only to reject low-order public keys, never for encapsulation.
    x25519.getSharedSecret(validationScalar, input.recipientPublicKey);
    recipientPublicKey = await suite.kem.deserializePublicKey(input.recipientPublicKey);
  } catch {
    throw new CryptoFailure("INPUT", "receipt.key");
  }
  let sender: Awaited<ReturnType<typeof suite.createSenderContext>>;
  try { sender = await suite.createSenderContext({ recipientPublicKey, info: input.info }); }
  catch { throw new CryptoFailure("RANDOM", "receipt"); }
  let ciphertext: Uint8Array;
  try { ciphertext = new Uint8Array(await sender.seal(plaintext, emptyAad)); }
  catch { throw new CryptoFailure("INTERNAL", "receipt"); }
  const packet = concat(new Uint8Array(sender.enc), ciphertext);
  if (packet.length !== 112) throw new CryptoFailure("INTERNAL", "receipt.packet");
  return packet;
}

export async function decryptReceipt(input: DecryptReceiptInput): Promise<Opening> {
  if (input.info.length !== 32) throw new CryptoFailure("INPUT", "receipt.info");
  if (input.packet.length !== 112) throw new CryptoFailure("INPUT", "receipt.packet");
  if (input.recipientPrivateKey.length !== 32) throw new CryptoFailure("INPUT", "receipt.key");
  try { parsePoint(input.commitment, true); }
  catch { throw new CryptoFailure("INPUT", "receipt.commitment"); }
  let plaintext: Uint8Array;
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(input.recipientPrivateKey);
    const recipient = await suite.createRecipientContext({
      recipientKey, enc: input.packet.slice(0, 32), info: input.info,
    });
    plaintext = new Uint8Array(await recipient.open(input.packet.slice(32), emptyAad));
  } catch {
    throw new CryptoFailure("DECRYPT", "receipt");
  }
  const opening = decodeOpening(plaintext);
  if (!samePoint(commit(opening), input.commitment)) {
    throw new CryptoFailure("COMMITMENT", "receipt");
  }
  return opening;
}
