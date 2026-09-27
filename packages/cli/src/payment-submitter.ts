import { join } from "node:path";
import { createPrivateDirectory, withWriterLock } from "./atomic-file.js";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "viem";
import type { Address, Hex } from "viem";
import type { Context, LocalDraft } from "@confidential-utxo/core";
import { createPaymentClient, encodePayCall } from "@confidential-utxo/uniswap";
import type { OperationRef, PaymentDeployment, PaymentPorts, ReconciledPayment,
  Scope, Bytes32 } from "@confidential-utxo/uniswap";
import { appendPaymentPrepared, listPaymentAttempts, recordPaymentSendResult } from "./payment-journal.js";
import type { PaymentJournalBinding } from "./payment-journal.js";
import { decodePaymentPublic } from "./payment-public.js";

type GasWallet = { account: { address: Address }; sendTransaction(args: {
  account: Address; to: Address; data: Hex; value: bigint; nonce: number;
  gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> };
type GasRpc = { getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  estimateGas(args: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> };

export async function submitPublicPayment(bytes: Uint8Array, binding: PaymentJournalBinding,
  wallet: GasWallet, rpc: GasRpc, journalDir: string, suppliedAttemptId?: Hex): Promise<OperationRef> {
  await createPrivateDirectory(journalDir);
  const lockDir = join(journalDir, "payment-submission");
  await createPrivateDirectory(lockDir);
  return withWriterLock(lockDir, () => submitPayment(bytes, binding, wallet, rpc, journalDir, suppliedAttemptId));
}

async function submitPayment(bytes: Uint8Array, binding: PaymentJournalBinding,
  wallet: GasWallet, rpc: GasRpc, journalDir: string, suppliedAttemptId?: Hex): Promise<OperationRef> {
  if (wallet.account.address.toLowerCase() !== binding.submitter.toLowerCase()) {
    throw new Error("PAYMENT_SUBMITTER_MISMATCH");
  }
  const publicFile = await decodePaymentPublic(bytes, binding.context, binding.deploymentId, binding.deployment);
  const draft = { context: binding.context, request: publicFile.poolSubmission.request,
    operationId: publicFile.operationId, balanceProof: publicFile.poolSubmission.balanceProof,
    rangeProofs: publicFile.poolSubmission.rangeProofs } as LocalDraft;
  const data = encodePayCall(draft, publicFile.terms, binding.deployment,
    publicFile.poolSubmission.signature, publicFile.paymentSignature);
  const previous = (await listPaymentAttempts(journalDir, binding)).some(item =>
    item.paymentId.toLowerCase() === publicFile.paymentId.toLowerCase() ||
    item.operationId.toLowerCase() === publicFile.operationId.toLowerCase());
  // Only the owner/common recovery path supplies an attempt ID, after checking
  // finalized evidence. Repeating public submit is never permission to retry.
  if (previous && suppliedAttemptId === undefined) throw new Error("PAYMENT_RECOVERY_REQUIRED");
  const nonce = await rpc.getTransactionCount({ address: binding.submitter, blockTag: "pending" });
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("PAYMENT_GAS_UNAVAILABLE");
  const attemptId = suppliedAttemptId ?? bytesToHex(randomBytes(32));
  const [gas, fees] = await Promise.all([
    rpc.estimateGas({ account: binding.submitter, to: binding.deployment.adapter, data, value: 0n }),
    rpc.estimateFeesPerGas(),
  ]);
  if (gas <= 0n || !fees.maxFeePerGas || !fees.maxPriorityFeePerGas ||
    fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new Error("PAYMENT_GAS_UNAVAILABLE");
  const saved = await appendPaymentPrepared(journalDir, binding, {
    publicBytes: bytes, account: binding.submitter, nonce, gas,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }, attemptId);
  if (saved !== "saved") throw new Error("PAYMENT_JOURNAL_UNCERTAIN");
  const scope: Scope = { deploymentId: binding.deploymentId as Scope["deploymentId"],
    owner: publicFile.terms.owner };
  const base: OperationRef = { scope, operationId: publicFile.operationId as OperationRef["operationId"],
    paymentId: publicFile.paymentId as OperationRef["paymentId"],
    attemptIds: [attemptId as never], txHashes: [], chainOutcome: "unknown", receiptState: "none" };
  let txHash: Hex;
  try {
    txHash = await wallet.sendTransaction({ account: binding.submitter,
      to: binding.deployment.adapter, data, value: 0n, nonce, gas,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  } catch {
    await recordPaymentSendResult(journalDir, binding, attemptId, { state: "unknown" });
    return base;
  }
  const result = await recordPaymentSendResult(journalDir, binding, attemptId,
    { state: "pending", txHash });
  return result === "saved" ? { ...base, txHashes: [txHash as never], chainOutcome: "pending" } : base;
}

export async function reconcileCliPay(recordId: Bytes32, reference: OperationRef,
  paymentPorts: PaymentPorts): Promise<ReconciledPayment> {
  return createPaymentClient(paymentPorts).reconcile(recordId, reference);
}
