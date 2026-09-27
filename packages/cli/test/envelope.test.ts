import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "viem";
import type { Hex } from "viem";
import { createEnvelopeCodec, openEnvelope, sealEnvelope } from "../src/envelope.js";

type Case = {
  id: string;
  input: { outerBytes?: Hex; plaintext?: Hex; passphrase?: string; salt?: Hex; nonce?: Hex };
  expected: { decision: "accept" | "reject"; outerBytes?: Hex };
};
const cases = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/storage.json", import.meta.url), "utf8")) as Case[];
const find = (id: string) => {
  const vector = cases.find(item => item.id === id);
  if (!vector) throw new Error("missing vector");
  return vector;
};
const utf8 = (value: string) => new TextEncoder().encode(value);

describe("fixed storage envelope", () => {
  it("decrypts independently published vectors, including reordered raw headers", async () => {
    for (const vector of cases.filter(item => item.expected.decision === "accept")) {
      if (!vector.input.outerBytes || !vector.input.plaintext || vector.input.passphrase === undefined) continue;
      expect(await openEnvelope(hexToBytes(vector.input.outerBytes), utf8(vector.input.passphrase)))
        .toEqual(hexToBytes(vector.input.plaintext));
    }
  });

  it("matches the fixed encrypted envelope under supplied cryptographic randomness", async () => {
    const vector = find("VEC-08-ENVELOPE");
    const salt = hexToBytes(vector.input.salt!);
    const nonce = hexToBytes(vector.input.nonce!);
    const codec = createEnvelopeCodec(size => size === 16 ? salt : nonce);
    expect(await codec.seal(hexToBytes(vector.input.plaintext!), utf8(vector.input.passphrase!)))
      .toEqual(hexToBytes(vector.expected.outerBytes!));
  });

  it("rejects a wrong passphrase and corrupted authenticated fields", async () => {
    const original = hexToBytes(find("VEC-08-ENVELOPE").expected.outerBytes!);
    await expect(openEnvelope(original, utf8("wrong passphrase"))).rejects.toThrow();
    for (const id of ["VEC-08-RAW-HEADER-TAMPER", "VEC-08-TAG-TAMPER", "VEC-08-CIPHERTEXT-TAMPER"]) {
      const vector = find(id);
      await expect(openEnvelope(hexToBytes(vector.input.outerBytes!), utf8(vector.input.passphrase!)))
        .rejects.toThrow();
    }
  });

  it("rejects malformed/unknown envelope fields before using plaintext", async () => {
    for (const vector of cases.filter(item => item.expected.decision === "reject" && item.input.outerBytes)) {
      await expect(openEnvelope(hexToBytes(vector.input.outerBytes!), utf8(vector.input.passphrase!)))
        .rejects.toThrow();
    }
  });

  it("rejects a file over 16 MiB before running scrypt", async () => {
    const derive = vi.fn(async () => Buffer.alloc(32));
    const codec = createEnvelopeCodec(randomBytes, derive);
    await expect(codec.open(new Uint8Array(16 * 1024 * 1024 + 1), utf8("test")))
      .rejects.toThrow();
    expect(derive).not.toHaveBeenCalled();
  });

  it("round-trips fresh files with independent salt and nonce", async () => {
    const plaintext = utf8('{"key":"private"}');
    const password = utf8("pass phrase");
    const first = await sealEnvelope(plaintext, password);
    const second = await sealEnvelope(plaintext, password);
    expect(first).not.toEqual(second);
    expect(await openEnvelope(first, password)).toEqual(plaintext);
    expect(await openEnvelope(second, password)).toEqual(plaintext);
  });
});
