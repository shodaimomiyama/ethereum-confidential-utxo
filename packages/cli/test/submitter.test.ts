import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { operationId } from "@confidential-utxo/core";
import type { HistoryPort, PublicSubmission } from "@confidential-utxo/core";
import { privateKeyToAccount } from "viem/accounts";
import { TransactionReceiptNotFoundError } from "viem";
import type { Hex, PublicClient } from "viem";
import { createPrivateDirectory, replacePrivateFile } from "../src/atomic-file.js";
import { encodePublicSubmission } from "../src/public-files.js";
import { listAttempts, recordSendResult } from "../src/journal.js";
import { appendPrepared } from "../src/journal.js";
import { encodePoolSubmission } from "@confidential-utxo/ethereum";
import { SubmitterService } from "../src/submitter.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const vector = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/pool-operations.json", import.meta.url), "utf8"))[0];
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const submitter = privateKeyToAccount(`0x${"03".repeat(32)}`);
const context = { chainId: 31337n, pool: vector.input.pool as Hex, deploymentBlock: 1n,
  verifier: vector.input.pool as Hex, parametersHash: hash("33"), finalityMode: "local-simulated" as const };
const verified = { context } as any;
const request = { kind: 0 as const, owner: vector.input.owner as Hex, salt: vector.input.salt as Hex,
  inputIds: [] as Hex[], outputs: vector.input.outputs.map((output: any) => ({ owner: output.owner as Hex,
    commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) }, receiptFormat: 1 as const, packet: output.packet as Hex })),
  d: BigInt(vector.input.d), w: 0n, destination: vector.input.destination as Hex };
const submission: PublicSubmission = { request,
  balanceProof: { Rx: BigInt(vector.expected.balanceProof.Rx), Ry: BigInt(vector.expected.balanceProof.Ry),
    s: BigInt(vector.expected.balanceProof.s) }, rangeProofs: [], signature: vector.expected.signature as Hex };
const publicFile = encodePublicSubmission(context, submission);
const binding = { chainId: context.chainId, pool: context.pool, submitter: submitter.address };
const point = { number: 1n, hash: hash("aa"), mode: "local-simulated" as const };
function history(): HistoryPort {
  const complete = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  return { getFinalizedCheckpoint: async () => point, getContext: async () => complete(context),
    getCanonicalHeader: async () => complete({ number: point.number, hash: point.hash }),
    getOperations: async () => complete([]), getUtxo: async () => complete({ exists: false }),
    getOperationSuccess: async () => complete({ executed: false }), getLatestHeader: async () => point,
    getLatestUtxo: async () => complete({ exists: false }),
    getLatestOperationSuccess: async () => complete({ executed: false }) };
}
function wallet() {
  const sent: unknown[] = [];
  const mock = { account: submitter, getChainId: async () => 31337,
    estimateGas: async () => 100000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
    getBalance: async () => 1000000000n, getTransactionCount: async () => 7,
    sendTransaction: async (args: unknown) => { sent.push(args); return hash("bb"); } };
  return { mock, sent };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cutxo-submitter-")); roots.push(root);
  const signerDir = join(root, "signer"); await createPrivateDirectory(signerDir);
  const signerFile = join(signerDir, "submitter.key");
  await replacePrivateFile(signerFile, new TextEncoder().encode(`0x${"03".repeat(32)}`));
  return { journalDir: join(root, "journal"), signerFile };
}
const client = { getTransactionReceipt: async () => { throw new Error("not found"); },
  getBlock: async () => ({ hash: point.hash }) } as unknown as PublicClient;

it("rejects wrong public context and refuses to send when journal persistence is unknown", async () => {
  const f = await fixture(); const sender = wallet();
  const service = new SubmitterService(sender.mock, history(), client, {
    appendPrepared: async () => "unknown", recordSendResult, listAttempts });
  const result = await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  expect(result).toMatchObject({ kind: "submission", status: "unknown" });
  expect(sender.sent).toHaveLength(0);
  await expect(service.submit(publicFile, f.signerFile, f.journalDir,
    { context: { ...context, chainId: 1n } } as any)).rejects.toThrow();
  await expect(service.submit(publicFile, f.signerFile, f.journalDir,
    { context: { ...context, pool: submitter.address } } as any)).rejects.toThrow();
  const changed = JSON.parse(new TextDecoder().decode(publicFile));
  changed.signature = `0x${"00".repeat(65)}`;
  await expect(service.submit(new TextEncoder().encode(JSON.stringify(changed)), f.signerFile, f.journalDir, verified)).rejects.toThrow();
  expect(sender.sent).toHaveLength(0);
});

it("reports unknown after accepted send when result persistence fails and never auto-retries orphan intent", async () => {
  const f = await fixture(); const sender = wallet();
  const service = new SubmitterService(sender.mock, history(), client, {
    appendPrepared: (await import("../src/journal.js")).appendPrepared,
    recordSendResult: async () => "unknown", listAttempts });
  const result = await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  expect(result).toMatchObject({ kind: "submission", status: "unknown" });
  expect(sender.sent).toHaveLength(1);
  expect((await listAttempts(f.journalDir, binding))[0]?.state).toBe("unknown");
  const restarted = new SubmitterService(sender.mock, history(), client);
  const inspection = await restarted.inspect(operationId(context, request), f.journalDir, verified);
  expect(inspection).toMatchObject({ kind: "operation", status: "unknown" });
  const retry = await restarted.retry(operationId(context, request), f.signerFile, f.journalDir, verified);
  expect(retry).toMatchObject({ kind: "submission", status: "unknown" });
  expect(sender.sent).toHaveLength(1);
});

it("does not mistake a successful outer receipt without a logical success event for execution", async () => {
  const f = await fixture(); const sender = wallet();
  const outerOnly = { getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n,
    blockHash: point.hash, gasUsed: 100000n, effectiveGasPrice: 100n }),
    getBlock: async () => ({ hash: point.hash }) } as unknown as PublicClient;
  const service = new SubmitterService(sender.mock, history(), outerOnly);
  const submitted = await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  expect(submitted).toMatchObject({ status: "pending" });
  const restarted = new SubmitterService(sender.mock, history(), outerOnly);
  const id = operationId(context, request);
  expect(await restarted.inspect(id, f.journalDir, verified)).toMatchObject({ kind: "operation", status: "unknown" });
  expect(await restarted.retry(id, f.signerFile, f.journalDir, verified)).toMatchObject({ status: "unknown" });
  expect(sender.sent).toHaveLength(1);
});

it("inspects a known pending hash and replaces its fee while retaining the earlier attempt", async () => {
  const f = await fixture(); const sender = wallet();
  const pendingClient = { getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash: hash("bb") }); },
    getBlock: async () => ({ hash: point.hash }) } as unknown as PublicClient;
  const service = new SubmitterService(sender.mock, history(), pendingClient);
  const submitted = await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  expect(submitted).toMatchObject({ kind: "submission", status: "pending" });
  const attempt = (await listAttempts(f.journalDir, binding))[0]!;
  expect(await service.inspect(attempt.operationId, f.journalDir, verified)).toMatchObject({ status: "pending" });
  const replacement = await service.replaceFee(attempt.attemptId, 120n, 3n, f.signerFile, f.journalDir, verified);
  expect(replacement).toMatchObject({ kind: "submission", status: "pending" });
  expect(sender.sent).toHaveLength(2);
  const attempts = await listAttempts(f.journalDir, binding);
  expect(attempts).toHaveLength(2);
  expect(attempts.map(item => item.nonce)).toEqual([7, 7]);
  expect(attempts.map(item => item.maxFeePerGas)).toEqual([100n, 120n]);
});

it("permits explicit retry only after a canonical failed outer transaction", async () => {
  const f = await fixture(); const sender = wallet();
  const failedClient = { getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 1n,
    blockHash: point.hash, gasUsed: 100000n, effectiveGasPrice: 100n }),
    getBlock: async () => ({ hash: point.hash }) } as unknown as PublicClient;
  const service = new SubmitterService(sender.mock, history(), failedClient);
  await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  const id = operationId(context, request);
  expect(await service.inspect(id, f.journalDir, verified)).toMatchObject({ status: "failed" });
  expect(await service.retry(id, f.signerFile, f.journalDir, verified)).toMatchObject({ status: "pending" });
  expect(sender.sent).toHaveLength(2);
});

it("does not retry an operation with verified success evidence", async () => {
  const f = await fixture(); const sender = wallet(); const h = history();
  const service = new SubmitterService(sender.mock, h, client);
  await service.submit(publicFile, f.signerFile, f.journalDir, verified);
  const id = operationId(context, request);
  const location = { blockNumber: point.number, blockHash: point.hash, transactionHash: hash("cc"), transactionIndex: 0 };
  const event = { request, success: { ...location, operationId: id, logIndex: 1 }, inputLogs: [],
    outputLogs: [{ ...location, operationId: id, outputId: hash("dd"), outputIndex: 0,
      output: request.outputs[0]!, logIndex: 0 }] };
  const complete = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  h.getLatestOperationSuccess = async () => complete({ executed: true, operation: request });
  h.getOperationSuccess = async () => complete({ executed: true, operation: request });
  h.getOperations = async () => complete([event]);
  expect(await service.retry(id, f.signerFile, f.journalDir, verified)).toMatchObject({ status: "executed" });
  expect(sender.sent).toHaveLength(1);
});

it("does not retry or replace a request whose input was consumed by another operation", async () => {
  const f = await fixture(); const sender = wallet();
  const item = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/pool-operations.json", import.meta.url), "utf8"))
    .find((entry: { id: string }) => entry.id === "VEC-07-POOL-TRANSFER-PARTIAL");
  const input = item.input;
  const transfer: PublicSubmission = { request: { kind: 1, owner: input.owner, salt: input.salt,
    inputIds: input.inputIds, outputs: input.outputs.map((output: any) => ({ owner: output.owner,
      commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) }, receiptFormat: 1, packet: output.packet })),
    d: 0n, w: 0n, destination: input.destination },
    balanceProof: { Rx: BigInt(item.expected.balanceProof.Rx), Ry: BigInt(item.expected.balanceProof.Ry),
      s: BigInt(item.expected.balanceProof.s) },
    rangeProofs: item.expected.rangeProofs.map((range: any) => ({ coords: range.coords.map(BigInt),
      scalars: range.scalars.map(BigInt), ls: range.ls.map(BigInt), rs: range.rs.map(BigInt) })),
    signature: item.expected.signature };
  const id = operationId(context, transfer.request);
  const call = encodePoolSubmission(transfer);
  await appendPrepared(f.journalDir, binding, { operationId: id, account: submitter.address, request: transfer,
    calldata: call.data, value: call.value, nonce: 7, gas: 100000n, maxFeePerGas: 100n,
    maxPriorityFeePerGas: 2n }, hash("ee"));
  const h = history();
  h.getLatestUtxo = async () => ({ complete: true, blockHash: point.hash,
    value: { exists: true, owner: transfer.request.owner,
      commitment: transfer.request.outputs[0]!.commitment, consumedBy: hash("ff") } });
  const service = new SubmitterService(sender.mock, h, client);
  expect(await service.retry(id, f.signerFile, f.journalDir, verified)).toMatchObject({ status: "competing" });
  await expect(service.replaceFee(hash("ee"), 120n, 3n, f.signerFile, f.journalDir, verified)).rejects.toThrow();
  expect(sender.sent).toHaveLength(0);
});
