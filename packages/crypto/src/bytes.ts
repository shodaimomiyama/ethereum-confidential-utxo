import { keccak_256 } from "@noble/hashes/sha3.js";

const WORD_LIMIT = 1n << 256n;

export function word(value: bigint): Uint8Array {
  if (value < 0n || value >= WORD_LIMIT) throw new RangeError("uint256 out of range");
  const bytes = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function hexBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new RangeError("invalid hex bytes");
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}

export function tag(label: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(label));
}

export function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
