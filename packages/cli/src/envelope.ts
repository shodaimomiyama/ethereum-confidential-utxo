import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { base64Bytes, parseExactObject } from "./strict-json.js";

const maximumFileBytes = 16 * 1024 * 1024;
const profile = "scrypt-aes256gcm-v1";

function deriveKey(passphrase: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  const password = Buffer.from(passphrase);
  const saltBytes = Buffer.from(salt);
  return new Promise((resolve, reject) => {
    scrypt(password, saltBytes, 32,
      { N: 131072, r: 8, p: 1, maxmem: 268435456 },
      (error, key) => {
        password.fill(0);
        if (error) reject(new Error("KDF_FAILED"));
        else resolve(key);
      });
  });
}

function invalid(): never {
  throw new Error("INVALID_ENVELOPE");
}

export function createEnvelopeCodec(
  random: (size: number) => Uint8Array = randomBytes,
  derive: (passphrase: Uint8Array, salt: Uint8Array) => Promise<Buffer> = deriveKey,
) {
  return {
    seal: async (plaintext: Uint8Array, passphrase: Uint8Array): Promise<Uint8Array> => {
      if (plaintext.length > maximumFileBytes) invalid();
      const salt = Buffer.from(random(16));
      const nonce = Buffer.from(random(12));
      if (salt.length !== 16 || nonce.length !== 12) invalid();
      const header = Buffer.from(JSON.stringify({
        version: 1, profile, salt: salt.toString("base64"), nonce: nonce.toString("base64"),
      }), "utf8");
      const key = await derive(passphrase, salt);
      try {
        if (key.length !== 32) invalid();
        const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
        cipher.setAAD(header);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const file = Buffer.from(JSON.stringify({
          header: header.toString("base64"), ciphertext: ciphertext.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
        }), "utf8");
        if (file.length > maximumFileBytes) invalid();
        return new Uint8Array(file);
      } finally {
        key.fill(0);
      }
    },
    open: async (file: Uint8Array, passphrase: Uint8Array): Promise<Uint8Array> => {
      if (file.length > maximumFileBytes) invalid();
      const outer = parseExactObject(file, ["header", "ciphertext", "tag"]);
      const header = base64Bytes(outer.header);
      const ciphertext = base64Bytes(outer.ciphertext);
      const tag = base64Bytes(outer.tag, 16);
      const fields = parseExactObject(header, ["version", "profile", "salt", "nonce"]);
      if (fields.version !== 1 || fields.profile !== profile) invalid();
      const salt = base64Bytes(fields.salt, 16);
      const nonce = base64Bytes(fields.nonce, 12);
      const key = await derive(passphrase, salt);
      let provisional = Buffer.alloc(0);
      let final = Buffer.alloc(0);
      try {
        if (key.length !== 32) invalid();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
        decipher.setAAD(header);
        decipher.setAuthTag(tag);
        provisional = decipher.update(ciphertext);
        try { final = decipher.final(); }
        catch { invalid(); }
        const plaintext = Buffer.concat([provisional, final]);
        try {
          return new Uint8Array(plaintext);
        } finally {
          plaintext.fill(0);
        }
      } finally {
        provisional.fill(0);
        final.fill(0);
        key.fill(0);
      }
    },
  };
}

const codec = createEnvelopeCodec();
export const sealEnvelope = codec.seal;
export const openEnvelope = codec.open;
