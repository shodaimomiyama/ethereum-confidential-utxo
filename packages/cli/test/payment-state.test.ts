import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Context } from "@confidential-utxo/core";
import { decodeOwnerSnapshot, encodeOwnerSnapshot, initializeOwnerState, readOwnerState } from "../src/state.js";
import { readPaymentProgress, savePaymentProgress } from "../src/payment-state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const owner = "0x1111111111111111111111111111111111111111" as const;
const context: Context = { chainId: 31337n, pool: "0x2222222222222222222222222222222222222222",
  deploymentBlock: 1n, verifier: "0x3333333333333333333333333333333333333333",
  parametersHash: `0x${"44".repeat(32)}`, finalityMode: "local-simulated" };
const passphrase = new TextEncoder().encode("test passphrase");

it("adds encrypted payment progress to old owner snapshots with revision checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-state-")); roots.push(dir);
  await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context, owner,
    receiptKeys: [], activeReceiptKeyId: null, operations: {}, sync: null, restoration: "ready" });
  expect((await readOwnerState(dir, passphrase)).connection).toBeUndefined();
  const next = { revision: 1, deploymentId: "local-v1", recordKey: `0x${"55".repeat(32)}` as const,
    rewards: {}, payments: {} };
  await savePaymentProgress(dir, passphrase, owner, { revision: 0 }, next);
  expect((await readPaymentProgress(dir, passphrase, owner)).revision).toBe(1);
  await expect(savePaymentProgress(dir, passphrase, owner, { revision: 0 }, { ...next, revision: 2 }))
    .rejects.toThrow();
  expect((await readOwnerState(dir, passphrase)).connection?.recordKey).toBe(next.recordKey);
  const snapshot = encodeOwnerSnapshot(await readOwnerState(dir, passphrase));
  expect(decodeOwnerSnapshot(snapshot).connection?.revision).toBe(1);
  const restored = decodeOwnerSnapshot(snapshot);
  restored.restoration = "needs-resync";
  expect(restored.connection?.recordKey).toBe(next.recordKey);
  const competing = await Promise.allSettled([
    savePaymentProgress(dir, passphrase, owner, { revision: 1 }, { ...next, revision: 2 }),
    savePaymentProgress(dir, passphrase, owner, { revision: 1 }, { ...next, revision: 2 }),
  ]);
  expect(competing.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await readPaymentProgress(dir, passphrase, owner)).revision).toBe(2);
});
