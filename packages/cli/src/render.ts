import type { Writable } from "node:stream";
import { CoreFailure } from "@confidential-utxo/core";
import type { Checkpoint } from "@confidential-utxo/core";
import { EthereumFailure } from "@confidential-utxo/ethereum";
import type { Address, Hex } from "viem";

const privateAmount = Symbol("private balance");
export type PrivateBalance = Readonly<{ [privateAmount]: bigint }>;
export function privateBalance(wei: bigint): PrivateBalance {
  if (wei < 0n) throw new Error("INVALID_BALANCE");
  return Object.freeze({ [privateAmount]: wei });
}

export type OperationStatus = "fixed" | "proved" | "authorized" | "pending" | "unknown" |
  "executed" | "failed" | "competing" | "inconsistent" | "stale";
export type PublicAttempt = { attemptId: Hex; state: "unknown" | "pending" | "observed";
  txHash?: Hex; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
export type PublicReceiptFailure = { outputId: Hex; status: "unknown" | "inconsistent"; reason: string };
export type CliResult =
  | { kind: "init"; owner: Address; chainId: bigint; pool: Address }
  | { kind: "key"; keyId: Hex; action: "added" | "selected" }
  | { kind: "created"; operationId: Hex; phase: "fixed" | "proved" | "authorized" }
  | { kind: "abandoned"; operationId: Hex }
  | { kind: "submission"; operationId: Hex; status: "pending" | "unknown" | "executed" | "failed" | "competing"; txHash?: Hex; attemptId?: Hex }
  | { kind: "operation"; operationId: Hex; status: OperationStatus; checkpoint?: Checkpoint; txHash?: Hex; attempts?: PublicAttempt[] }
  | { kind: "sync"; status: "complete" | "unconfirmed" | "stale" | "inconsistent"; checkpoint?: Checkpoint; receiptStatus?: "available" | "spent" | "unknown"; receiptFailures?: PublicReceiptFailure[] }
  | { kind: "balance"; status: "available" | "unknown" | "stale"; amount?: PrivateBalance; checkpoint?: Checkpoint; receiptFailures?: PublicReceiptFailure[] }
  | { kind: "utxos"; status: "complete" | "stale"; entries: { id: Hex; status: string; amount?: PrivateBalance }[]; checkpoint?: Checkpoint; receiptFailures?: PublicReceiptFailure[] }
  | { kind: "recipient"; owner: Address; path: string }
  | { kind: "export"; operationId: Hex; path: string }
  | { kind: "backup"; status: "created"; path: string }
  | { kind: "restored"; status: "needs-resync"; owner: Address }
  | { kind: "passphrase"; status: "changed" }
  | { kind: "error"; code: "INPUT" | "CONFIG" | "STORAGE" | "LOCK" | "RPC" | "UNKNOWN" | "FAILED" | "CONFLICT" };

type RenderIO = { stdout: Writable; stderr: Writable; isTTY: boolean };
type Format = "human" | "json";
function checkpoint(value: Checkpoint | undefined) {
  return value ? { number: value.number.toString(), hash: value.hash, mode: value.mode } : undefined;
}
function exitCode(result: CliResult): number {
  if (result.kind === "error") {
    if (result.code === "INPUT" || result.code === "CONFIG") return 2;
    if (result.code === "STORAGE" || result.code === "LOCK") return 3;
    if (result.code === "FAILED" || result.code === "CONFLICT") return 5;
    return 4;
  }
  if (result.kind === "submission" || result.kind === "operation") {
    if (result.status === "failed" || result.status === "competing") return 5;
    if (result.status === "unknown" || result.status === "inconsistent" || result.status === "stale") return 4;
  }
  if (result.kind === "sync" && result.status !== "complete") return 4;
  if (result.kind === "balance" && result.status !== "available") return 4;
  if (result.kind === "utxos" && result.status !== "complete") return 4;
  return 0;
}
function publicDto(result: CliResult): Record<string, unknown> {
  switch (result.kind) {
    case "init": return { schemaVersion: 1, kind: "init", owner: result.owner, chainId: result.chainId.toString(), pool: result.pool };
    case "key": return { schemaVersion: 1, kind: "key", keyId: result.keyId, action: result.action };
    case "created": return { schemaVersion: 1, kind: "created", operationId: result.operationId, phase: result.phase };
    case "abandoned": return { schemaVersion: 1, kind: "abandoned", operationId: result.operationId };
    case "submission": return { schemaVersion: 1, kind: "submission", operationId: result.operationId, status: result.status,
      ...(result.txHash ? { txHash: result.txHash } : {}),
      ...(result.attemptId ? { attemptId: result.attemptId } : {}) };
    case "operation": return { schemaVersion: 1, kind: "operation", operationId: result.operationId, status: result.status,
      ...(result.checkpoint ? { checkpoint: checkpoint(result.checkpoint) } : {}),
      ...(result.txHash ? { txHash: result.txHash } : {}),
      ...(result.attempts ? { attempts: result.attempts } : {}) };
    case "sync": return { schemaVersion: 1, kind: "sync", status: result.status,
      ...(result.checkpoint ? { checkpoint: checkpoint(result.checkpoint) } : {}),
      ...(result.receiptStatus ? { receiptStatus: result.receiptStatus } : {}),
      ...(result.receiptFailures ? { receiptFailures: result.receiptFailures } : {}) };
    case "balance": return { schemaVersion: 1, kind: "balance", status: result.status,
      ...(result.checkpoint ? { checkpoint: checkpoint(result.checkpoint) } : {}),
      ...(result.receiptFailures ? { receiptFailures: result.receiptFailures } : {}) };
    case "utxos": return { schemaVersion: 1, kind: "utxos", status: result.status,
      entries: result.entries.map(item => ({ id: item.id, status: item.status })),
      ...(result.checkpoint ? { checkpoint: checkpoint(result.checkpoint) } : {}),
      ...(result.receiptFailures ? { receiptFailures: result.receiptFailures } : {}) };
    case "recipient": return { schemaVersion: 1, kind: "recipient", owner: result.owner, path: result.path };
    case "export": return { schemaVersion: 1, kind: "export", operationId: result.operationId, path: result.path };
    case "backup": return { schemaVersion: 1, kind: "backup", status: result.status, path: result.path };
    case "restored": return { schemaVersion: 1, kind: "restored", status: result.status, owner: result.owner };
    case "passphrase": return { schemaVersion: 1, kind: "passphrase", status: result.status };
    case "error": return { schemaVersion: 1, kind: "error", code: result.code };
  }
}

export function renderResult(result: CliResult, io: RenderIO, format: Format): number {
  const code = exitCode(result);
  if (format === "json") {
    io.stdout.write(`${JSON.stringify(publicDto(result))}\n`);
    return code;
  }
  const publicText = publicDto(result);
  const details = Object.entries(publicText).filter(([key]) => key !== "schemaVersion").map(([key, value]) =>
    `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" ");
  const destination = result.kind === "error" ? io.stderr : io.stdout;
  destination.write(`${details}\n`);
  if (result.kind === "balance" && result.status === "available" && io.isTTY && result.amount) {
    io.stdout.write(`availableWei=${result.amount[privateAmount].toString()}\n`);
  }
  if (result.kind === "utxos" && result.status === "complete" && io.isTTY) {
    for (const item of result.entries) if (item.amount) io.stdout.write(`${item.id} amountWei=${item.amount[privateAmount].toString()}\n`);
  }
  return code;
}

export function classifyError(error: unknown): Extract<CliResult, {kind:"error"}> {
  if (error instanceof CoreFailure) {
    const code = error.code;
    if (code === "INVALID_INPUT" || code === "INSUFFICIENT" || code === "UNCONSTRUCTABLE" || code === "SIGNATURE_REJECTED" || code === "SIGNATURE_INVALID" || code === "UNSUPPORTED") return { kind: "error", code: "INPUT" };
    if (code === "STORAGE_UNKNOWN") return { kind: "error", code: "STORAGE" };
    if (code === "CONFLICT") return { kind: "error", code: "CONFLICT" };
    return { kind: "error", code: "RPC" };
  }
  if (error instanceof EthereumFailure) {
    if (["INVALID_CONFIG", "DEPLOYMENT_MISMATCH", "UNSUPPORTED", "SIGNATURE_REJECTED", "SIGNATURE_INVALID"].includes(error.code)) return { kind: "error", code: "CONFIG" };
    if (error.code === "OUTER_REVERT") return { kind: "error", code: "FAILED" };
    if (error.code === "STORAGE_UNKNOWN") return { kind: "error", code: "STORAGE" };
    return { kind: "error", code: "RPC" };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "STORE_LOCKED") return { kind: "error", code: "LOCK" };
  if (["PRIVATE_FILE_INVALID", "INVALID_ENVELOPE", "INVALID_OWNER_STATE", "INVALID_JOURNAL", "KDF_FAILED"].includes(message)) return { kind: "error", code: "STORAGE" };
  if (["PUBLIC_FILE_INVALID", "INVALID_FORMAT", "SECRET_INPUT_INVALID", "OWNER_OPERATION_INVALID", "SUBMITTER_INVALID", "CLI_INPUT"].includes(message)) return { kind: "error", code: "INPUT" };
  return { kind: "error", code: "UNKNOWN" };
}
