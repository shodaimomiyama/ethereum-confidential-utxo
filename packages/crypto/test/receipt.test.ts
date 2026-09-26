import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { describe, expect, it } from "vitest";
import cases from "../../../tests/vectors/cases/hpke.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { decryptReceipt, encryptReceipt } from "../src/receipt.js";

const valid = cases.find((entry) => entry.id === "VEC-07-RECEIPT-VALID")!;
const receiptInput = (entry: typeof valid) => ({
  recipientPrivateKey: hexBytes(entry.input.recipientPrivateKey!),
  info: hexBytes(entry.input.info), packet: hexBytes(entry.input.packet!),
  commitment: { x: BigInt(entry.input.Cx!), y: BigInt(entry.input.Cy!) },
});

describe("HPKE receipt", () => {
  it("decrypts the independent valid packet", async () => {
    expect(await decryptReceipt(receiptInput(valid))).toEqual({ amount: 1n, blinding: 0n });
  });

  it("rejects malformed, tampered, and invalid plaintext packets by stage", async () => {
    const failures: Record<string, string> = {
      "VEC-07-SHORT-PACKET": "INPUT:receipt.packet",
      "VEC-07-LONG-PACKET": "INPUT:receipt.packet",
      "VEC-07-WRONG-KEY": "DECRYPT:receipt",
      "VEC-07-ENC-CHANGED": "DECRYPT:receipt",
      "VEC-07-CIPHERTEXT-CHANGED": "DECRYPT:receipt",
      "VEC-07-INFO-CHANGED": "DECRYPT:receipt",
      "VEC-07-ZERO-V": "PLAINTEXT:receipt",
      "VEC-07-V-OVER-M": "PLAINTEXT:receipt",
      "VEC-07-R-Q": "PLAINTEXT:receipt",
      "VEC-07-COMMITMENT-CHANGED": "COMMITMENT:receipt",
    };
    for (const [id, message] of Object.entries(failures)) {
      const entry = cases.find((candidate) => candidate.id === id)! as typeof valid;
      await expect(decryptReceipt(receiptInput(entry)), id).rejects.toThrowError(message);
    }
  });

  it("uses fresh sender encapsulation and rejects low-order recipient keys", async () => {
    const input = {
      recipientPublicKey: hexBytes(valid.input.recipientPublicKey),
      info: hexBytes(valid.input.info), opening: { amount: 1n, blinding: 0n },
    };
    const first = await encryptReceipt(input);
    const second = await encryptReceipt(input);
    expect(first).toHaveLength(112);
    expect(second).toHaveLength(112);
    expect(first.slice(0, 32)).not.toEqual(second.slice(0, 32));
    await expect(decryptReceipt({ ...receiptInput(valid), packet: first })).resolves.toEqual(input.opening);
    for (const id of ["VEC-07-RECIPIENT-KEY-ZERO", "VEC-07-RECIPIENT-KEY-LOW-ORDER"]) {
      const entry = cases.find((candidate) => candidate.id === id)!;
      await expect(encryptReceipt({ ...input, recipientPublicKey: hexBytes(entry.input.recipientPublicKey) }))
        .rejects.toThrowError("INPUT:receipt.key");
    }
  });

  it("matches the independent RFC 9180 A.2.1 encryption vector", async () => {
    const entry = cases.find((candidate) => candidate.id === "VEC-07-RFC-A2-BASE")!;
    const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
    const recipientPublicKey = await suite.kem.deserializePublicKey(hexBytes(entry.input.recipientPublicKey));
    const sender = await suite.createSenderContext({ recipientPublicKey, info: hexBytes(entry.input.info), ekm: hexBytes(entry.input.ikmE) });
    expect(new Uint8Array(sender.enc)).toEqual(hexBytes(entry.expected.enc!));
    expect(new Uint8Array(await sender.seal(hexBytes(entry.input.plaintext), hexBytes(entry.input.aad))))
      .toEqual(hexBytes(entry.expected.ciphertext!));
  });
});
