import { join } from "node:path";
import type { Context } from "@confidential-utxo/core";
import type { LocalDraft } from "@confidential-utxo/core";
import { encodePayCall } from "@confidential-utxo/uniswap";
import type { PaymentDeployment } from "@confidential-utxo/uniswap";
import type { Address, Hex } from "viem";
import { createPrivateDirectory, readPrivateFile, replacePrivateFile, withWriterLock } from "./atomic-file.js";
import { decodePaymentPublic } from "./payment-public.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";

const name = "payment-journal.json";
const maxBytes = 16 * 1024 * 1024;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new Error("INVALID_PAYMENT_JOURNAL"); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) ||
    Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uint(value: unknown): bigint { return decimalWei(value); }
function nonce(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function hash(value: unknown): Hex { return hexBytes(value, 32); }
function address(value: unknown): Address { return hexBytes(value, 20) as Address; }

export type PaymentJournalBinding = { context: Context; deploymentId: string;
  deployment: PaymentDeployment; submitter: Address };
export type PreparedPaymentSend = { publicBytes: Uint8Array; account: Address; nonce: number;
  gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type PaymentAttempt = { attemptId: Hex; operationId: Hex; paymentId: Hex;
  account: Address; calldata: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint; publicBytes: Uint8Array;
  state: "prepared" | "pending" | "unknown" | "observed"; txHash?: Hex };
type Row = Omit<PaymentAttempt, "publicBytes" | "gas" | "maxFeePerGas" | "maxPriorityFeePerGas"> & {
  publicFile: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string };

async function prepare(binding: PaymentJournalBinding, incoming: PreparedPaymentSend,
  attemptId: Hex): Promise<PaymentAttempt> {
  if (!same(incoming.account, binding.submitter) || nonce(incoming.nonce) !== incoming.nonce ||
    incoming.gas <= 0n || incoming.maxFeePerGas <= 0n || incoming.maxPriorityFeePerGas <= 0n ||
    incoming.maxPriorityFeePerGas > incoming.maxFeePerGas) invalid();
  const publicFile = await decodePaymentPublic(incoming.publicBytes, binding.context,
    binding.deploymentId, binding.deployment);
  const draft = { context: binding.context, request: publicFile.poolSubmission.request,
    operationId: publicFile.operationId, balanceProof: publicFile.poolSubmission.balanceProof,
    rangeProofs: publicFile.poolSubmission.rangeProofs } as LocalDraft;
  const calldata = encodePayCall(draft, publicFile.terms, binding.deployment,
    publicFile.poolSubmission.signature, publicFile.paymentSignature);
  return { attemptId: hash(attemptId), operationId: publicFile.operationId,
    paymentId: publicFile.paymentId, account: binding.submitter, calldata,
    nonce: incoming.nonce, gas: incoming.gas, maxFeePerGas: incoming.maxFeePerGas,
    maxPriorityFeePerGas: incoming.maxPriorityFeePerGas, publicBytes: incoming.publicBytes,
    state: "prepared" };
}
function serialize(binding: PaymentJournalBinding, attempts: PaymentAttempt[]): Uint8Array {
  const rows = attempts.map((item): Row => ({ attemptId: item.attemptId, operationId: item.operationId,
    paymentId: item.paymentId, account: item.account, calldata: item.calldata, nonce: item.nonce,
    gas: item.gas.toString(), maxFeePerGas: item.maxFeePerGas.toString(),
    maxPriorityFeePerGas: item.maxPriorityFeePerGas.toString(),
    publicFile: Buffer.from(item.publicBytes).toString("base64"), state: item.state,
    ...(item.txHash ? { txHash: item.txHash } : {}) }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, chainId: binding.context.chainId.toString(),
    pool: binding.context.pool, adapter: binding.deployment.adapter,
    deploymentId: binding.deploymentId, submitter: binding.submitter, attempts: rows }), "utf8");
  if (bytes.length > maxBytes) invalid();
  return bytes;
}
async function read(dir: string, binding: PaymentJournalBinding): Promise<PaymentAttempt[]> {
  let bytes: Uint8Array;
  try { bytes = await readPrivateFile(join(dir, name), maxBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const root = exact(parseExactObject(bytes, ["schemaVersion", "chainId", "pool", "adapter",
    "deploymentId", "submitter", "attempts"]),
  ["schemaVersion", "chainId", "pool", "adapter", "deploymentId", "submitter", "attempts"]);
  if (root.schemaVersion !== 1 || uint(root.chainId) !== binding.context.chainId ||
    !same(address(root.pool), binding.context.pool) ||
    !same(address(root.adapter), binding.deployment.adapter) ||
    root.deploymentId !== binding.deploymentId || !same(address(root.submitter), binding.submitter) ||
    !Array.isArray(root.attempts) || root.attempts.length > 100000) invalid();
  const attempts: PaymentAttempt[] = [];
  const seen = new Set<string>();
  for (const item of root.attempts) {
    const row = exact(item, ["attemptId", "operationId", "paymentId", "account", "calldata", "nonce",
      "gas", "maxFeePerGas", "maxPriorityFeePerGas", "publicFile", "state"], ["txHash"]);
    const attemptId = hash(row.attemptId);
    if (seen.has(attemptId.toLowerCase()) || typeof row.publicFile !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(row.publicFile)) invalid();
    seen.add(attemptId.toLowerCase());
    const publicBytes = Buffer.from(row.publicFile, "base64");
    if (publicBytes.length > 2 * 1024 * 1024 || Buffer.from(publicBytes).toString("base64") !== row.publicFile) invalid();
    const prepared = await prepare(binding, { publicBytes, account: address(row.account), nonce: nonce(row.nonce),
      gas: uint(row.gas), maxFeePerGas: uint(row.maxFeePerGas),
      maxPriorityFeePerGas: uint(row.maxPriorityFeePerGas) }, attemptId);
    if (!same(hash(row.operationId), prepared.operationId) ||
      !same(hash(row.paymentId), prepared.paymentId) ||
      !same(hexBytes(row.calldata, prepared.calldata.length / 2 - 1), prepared.calldata) ||
      !["prepared", "pending", "unknown", "observed"].includes(String(row.state))) invalid();
    const txHash = row.txHash === undefined ? undefined : hash(row.txHash);
    if ((row.state === "pending" || row.state === "observed") && !txHash) invalid();
    attempts.push({ ...prepared, state: row.state as PaymentAttempt["state"], ...(txHash ? { txHash } : {}) });
  }
  return attempts;
}

export async function appendPaymentPrepared(dir: string, binding: PaymentJournalBinding,
  incoming: PreparedPaymentSend, attemptId: Hex): Promise<"saved" | "unknown"> {
  const prepared = await prepare(binding, incoming, attemptId);
  await createPrivateDirectory(dir);
  return withWriterLock(dir, async () => {
    const attempts = await read(dir, binding);
    if (attempts.some(item => same(item.attemptId, attemptId) ||
      item.nonce === prepared.nonce)) invalid();
    try { await replacePrivateFile(join(dir, name), serialize(binding, [...attempts, prepared])); return "saved"; }
    catch { return "unknown"; }
  });
}

export async function recordPaymentSendResult(dir: string, binding: PaymentJournalBinding,
  attemptId: Hex, result: { state: "pending" | "unknown" | "observed"; txHash?: Hex }): Promise<"saved" | "unknown"> {
  if ((result.state === "pending" || result.state === "observed") && !result.txHash) invalid();
  return withWriterLock(dir, async () => {
    const attempts = await read(dir, binding);
    const item = attempts.find(value => same(value.attemptId, hash(attemptId)));
    if (!item) invalid();
    item.state = result.state;
    if (result.txHash) item.txHash = hash(result.txHash);
    try { await replacePrivateFile(join(dir, name), serialize(binding, attempts)); return "saved"; }
    catch { return "unknown"; }
  });
}

export async function listPaymentAttempts(dir: string, binding: PaymentJournalBinding): Promise<PaymentAttempt[]> {
  const attempts = await read(dir, binding);
  return attempts.map(item => ({ ...item, state: item.state === "prepared" ? "unknown" : item.state }));
}
