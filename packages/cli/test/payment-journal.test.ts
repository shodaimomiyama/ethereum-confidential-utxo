import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encodePaymentPublic } from "../src/payment-public.js";
import { appendPaymentPrepared, listPaymentAttempts, recordPaymentSendResult } from "../src/payment-journal.js";
import { context, deployment, fixture } from "./payment-public.test.js";

it("records public Adapter send intent before broadcast and preserves unknown outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-journal-"));
  try {
    const { terms, submission, paymentSignature } = await fixture();
    const publicBytes = encodePaymentPublic(context, "local-v1", deployment, terms, submission, paymentSignature);
    const binding = { context, deployment, deploymentId: "local-v1",
      submitter: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const };
    const attemptId = `0x${"bb".repeat(32)}` as const;
    const prepared = { publicBytes, account: binding.submitter, nonce: 1,
      gas: 500_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    expect(await appendPaymentPrepared(dir, binding, prepared, attemptId)).toBe("saved");
    let attempts = await listPaymentAttempts(dir, binding);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("unknown");
    expect(attempts[0]?.calldata.startsWith("0x")).toBe(true);
    expect(JSON.stringify(attempts, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("blinding");
    expect(await recordPaymentSendResult(dir, binding, attemptId, { state: "unknown" })).toBe("saved");
    attempts = await listPaymentAttempts(dir, binding);
    expect(attempts[0]?.state).toBe("unknown");
    await expect(appendPaymentPrepared(dir, binding, prepared, attemptId)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
