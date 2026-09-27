import { mkdtemp, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commit, decryptReceipt, encryptReceipt } from "@confidential-utxo/crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createPrivateDirectory, replacePrivateFile } from "../src/atomic-file.js";
import { generateReceiptKey, promptPassphrase, readLocalSigner } from "../src/secret-input.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("reads a private signer file and rejects wrong account, mode, link and malformed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-signer-"));
  roots.push(root);
  const dir = join(root, "keys");
  await createPrivateDirectory(dir);
  const path = join(dir, "signer.key");
  const privateKey = `0x${"11".repeat(32)}` as const;
  await replacePrivateFile(path, new TextEncoder().encode(privateKey));
  const owner = privateKeyToAccount(privateKey).address;
  expect((await readLocalSigner(path, owner)).address.toLowerCase()).toBe(owner.toLowerCase());
  await expect(readLocalSigner(path, "0x2222222222222222222222222222222222222222")).rejects.toThrow();
  await chmod(path, 0o644);
  await expect(readLocalSigner(path, owner)).rejects.toThrow();
  await chmod(path, 0o600);
  const link = join(dir, "link.key");
  await symlink(path, link);
  await expect(readLocalSigner(link, owner)).rejects.toThrow();
  for (const invalid of ["0x12", `0x${"zz".repeat(32)}`]) {
    await replacePrivateFile(path, new TextEncoder().encode(invalid));
    await expect(readLocalSigner(path, owner)).rejects.toThrow();
  }
});
it("generates a key pair usable by the receipt cipher", async () => {
  const key = generateReceiptKey();
  expect(key.secretKey).toHaveLength(32);
  expect(key.publicKey).toHaveLength(32);
  const opening = { amount: 2n, blinding: 3n };
  const packet = await encryptReceipt({ recipientPublicKey: key.publicKey, info: new Uint8Array(32), opening });
  expect(await decryptReceipt({ recipientPrivateKey: key.secretKey, info: new Uint8Array(32), packet, commitment: commit(opening) })).toEqual(opening);
});
it("rejects passphrase input without a TTY", async () => {
  await expect(promptPassphrase("unlock")).rejects.toThrow();
});
