import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encodePaymentPublic } from "../src/payment-public.js";
import { listPaymentAttempts, recordPaymentSendResult } from "../src/payment-journal.js";
import { submitPublicPayment } from "../src/payment-submitter.js";
import { context, deployment, fixture } from "./payment-public.test.js";

it("submits a signed public payment with another gas key and retains unknown sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-submitter-"));
  try {
    const { terms, submission, paymentSignature } = await fixture();
    const publicBytes = encodePaymentPublic(context, "local-v1", deployment, terms, submission, paymentSignature);
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const binding = { context, deploymentId: "local-v1", deployment, submitter: address };
    let sends = 0;
    const wallet = { account: { address }, sendTransaction: async () => {
      sends++;
      throw new Error("response lost after accept");
    } };
    const rpc = { getTransactionCount: async () => 0,
      estimateGas: async () => 500_000n, estimateFeesPerGas: async () => ({
        maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) };
    const result = await submitPublicPayment(publicBytes, binding, wallet, rpc, dir);
    expect(result.chainOutcome).toBe("unknown");
    expect(result.paymentId).toBeDefined();
    expect(sends).toBe(1);
    expect((await listPaymentAttempts(dir, binding))[0]?.state).toBe("unknown");
    await expect(submitPublicPayment(publicBytes, binding, wallet, rpc, dir))
      .rejects.toThrow("PAYMENT_RECOVERY_REQUIRED");
    expect(sends).toBe(1);
    const changed = JSON.parse(new TextDecoder().decode(publicBytes));
    changed.terms.ethAmount = "4";
    await expect(submitPublicPayment(new TextEncoder().encode(JSON.stringify(changed)), binding,
      wallet, rpc, dir)).rejects.toThrow();
    expect(sends).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(["pending", "unknown", "observed"] as const)("blocks repeated public submit for a %s attempt even after nonce advancement", async state => {
  const dir = await mkdtemp(join(tmpdir(), "payment-repeat-"));
  try {
    const { terms, submission, paymentSignature } = await fixture();
    const bytes = encodePaymentPublic(context, "local-v1", deployment, terms, submission, paymentSignature);
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const binding = { context, deploymentId: "local-v1", deployment, submitter: address };
    let sends = 0;
    let nonce = 0;
    const txHash = `0x${"cd".repeat(32)}` as const;
    const wallet = { account: { address }, sendTransaction: async () => { sends++; return txHash; } };
    const rpc = { getTransactionCount: async () => nonce,
      estimateGas: async () => 500_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) };
    const first = await submitPublicPayment(bytes, binding, wallet, rpc, dir);
    await recordPaymentSendResult(dir, binding, first.attemptIds[0] as never, { state, txHash });
    for (nonce of [0, 1]) {
      await expect(submitPublicPayment(bytes, binding, wallet, rpc, dir)).rejects.toThrow("PAYMENT_RECOVERY_REQUIRED");
    }
    expect(sends).toBe(1);
    expect(await listPaymentAttempts(dir, binding)).toHaveLength(1);
    // Common recovery has checked finalized evidence and allocated a new attempt.
    nonce = 1;
    const retryId = `0x${"ab".repeat(32)}` as const;
    const retried = await submitPublicPayment(bytes, binding, wallet, rpc, dir, retryId);
    expect(retried.attemptIds).toEqual([retryId]);
    expect(sends).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
