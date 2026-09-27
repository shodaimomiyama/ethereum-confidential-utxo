import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commit } from "@confidential-utxo/crypto";
import { operationId, outputId } from "@confidential-utxo/core";
import { zeroAddress, type Hex } from "viem";
import { createPrivateDirectory, replacePrivateFile } from "../src/atomic-file.js";
import { sealEnvelope } from "../src/envelope.js";
import { initializeOwnerState, readOwnerState, updateOwnerState, type WalletStateV1 } from "../src/state.js";

const roots: string[] = [];
const passphrase = new TextEncoder().encode("exact passphrase ");
const owner = "0x1111111111111111111111111111111111111111" as const;
const pool = "0x2222222222222222222222222222222222222222" as const;
const hash = `0x${"ab".repeat(32)}` as Hex;
const context = { chainId: 31337n, pool, deploymentBlock: 1n, verifier: "0x3333333333333333333333333333333333333333" as const, parametersHash: hash, finalityMode: "local-simulated" as const };
function initial(): WalletStateV1 {
  return { schemaVersion: 1, context, owner, receiptKeys: [], activeReceiptKeyId: null,
    operations: {}, sync: null, restoration: "ready" };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cutxo-state-"));
  roots.push(root);
  const dir = join(root, "owner");
  await createPrivateDirectory(dir);
  await initializeOwnerState(dir, passphrase, initial());
  return dir;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("owner state transactions", () => {
  it("preserves a key and fixed operation when a stale caller later stores sync", async () => {
    const dir = await fixture();
    const stale = await readOwnerState(dir, passphrase);
    const opening = { amount: 1n, blinding: 1n };
    const request = { kind: 0 as const, owner, salt: hash, inputIds: [], outputs: [
      { owner, commitment: commit(opening), receiptFormat: 1 as const, packet: `0x${"01".repeat(112)}` as Hex },
    ], d: 1n, w: 0n, destination: zeroAddress };
    const id = operationId(context, request);
    const fixed = { context, request, operationId: id, outputIds: [outputId(id, 0)], openings: [opening], inputOpenings: [] };
    const secretKey = `0x${"01".repeat(32)}` as Hex;
    const privateObject = createPrivateKey({ key: Buffer.from(`302e020100300506032b656e04220420${"01".repeat(32)}`, "hex"), format: "der", type: "pkcs8" });
    const publicKey = `0x${createPublicKey(privateObject).export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as Hex;
    const key = { id: hash, secretKey, publicKey };
    await updateOwnerState(dir, passphrase, current => ({ ...current,
      receiptKeys: [...current.receiptKeys, key], activeReceiptKeyId: key.id,
      operations: { ...current.operations, [id]: { phase: "fixed", fixed } },
    }));
    expect(stale.operations).toEqual({});
    await updateOwnerState(dir, passphrase, current => ({ ...current,
      sync: { status: "unconfirmed", reason: "NO_FINALITY" } }));
    const loaded = await readOwnerState(dir, passphrase);
    await expect(readOwnerState(dir, passphrase, { ...context, pool: owner }, owner)).rejects.toThrow();
    await expect(readOwnerState(dir, passphrase, context, pool)).rejects.toThrow();
    expect(loaded.receiptKeys).toEqual([key]);
    expect(loaded.operations[id]).toEqual({ phase: "fixed", fixed });
    expect(loaded.sync).toEqual({ status: "unconfirmed", reason: "NO_FINALITY" });
    await expect(updateOwnerState(dir, passphrase, current => ({ ...current,
      receiptKeys: [...current.receiptKeys, key],
    }))).rejects.toThrow();
    await expect(updateOwnerState(dir, passphrase, current => {
      const broken = structuredClone(current);
      const record = broken.operations[id];
      if (!record) throw new Error("missing operation");
      record.fixed.openings[0] = { amount: 2n, blinding: 1n };
      return broken;
    })).rejects.toThrow();
    expect((await readOwnerState(dir, passphrase)).operations[id]).toEqual({ phase: "fixed", fixed });
  });

  it("rejects malformed versions and context, duplicate keys, and mismatched operation map keys", async () => {
    const dir = await fixture();
    for (const changed of [
      { ...initial(), schemaVersion: 2 },
      { ...initial(), context: { ...context, chainId: 1n } },
      { ...initial(), receiptKeys: [{ id: hash, secretKey: hash, publicKey: hash }, { id: hash, secretKey: hash, publicKey: hash }] },
      { ...initial(), activeReceiptKeyId: hash },
      { ...initial(), operations: { [hash]: { phase: "fixed" } } },
    ]) {
      const plain = Buffer.from(JSON.stringify(changed, (_, value) => typeof value === "bigint" ? value.toString() : value));
      await replacePrivateFile(join(dir, "state.enc"), await sealEnvelope(plain, passphrase));
      await expect(readOwnerState(dir, passphrase, context, owner)).rejects.toThrow();
    }
  });

  it("rejects oversized encrypted state before decrypting", async () => {
    const dir = await fixture();
    await replacePrivateFile(join(dir, "state.enc"), new Uint8Array(16 * 1024 * 1024 + 1));
    await expect(readOwnerState(dir, passphrase)).rejects.toThrow();
  });
});
