import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { PublicSubmission, HistoryPort } from "@confidential-utxo/core";
import { operationId } from "@confidential-utxo/core";
import type { VerifiedDeployment } from "../src/deployment.js";
import { poolAbi } from "../src/abi.js";
import { encodePoolSubmission, submitPublicOperation, replaceSubmissionFee, prepareSignedRaw } from "../src/submission.js";
import type { PreparedSend, SubmissionWallet } from "../src/submission.js";

const vector = JSON.parse(readFileSync("tests/vectors/cases/pool-operations.json", "utf8"))[0];
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const context = { chainId: 31337n, pool: vector.input.pool, deploymentBlock: 1n,
  verifier: "0x2222222222222222222222222222222222222222" as Hex, parametersHash: hash("3"),
  finalityMode: "local-simulated" as const };
const verified = { context } as unknown as VerifiedDeployment;
const request = { kind: vector.input.kind, owner: vector.input.owner, salt: vector.input.salt,
  inputIds: vector.input.inputIds, outputs: vector.input.outputs.map((o: any) => ({
    owner: o.owner, commitment: { x: BigInt(o.Cx), y: BigInt(o.Cy) },
    receiptFormat: 1, packet: o.packet,
  })), d: BigInt(vector.input.d), w: BigInt(vector.input.w), destination: vector.input.destination };
const submission: PublicSubmission = { request,
  balanceProof: Object.fromEntries(Object.entries(vector.expected.balanceProof).map(([key, value]) => [key, BigInt(value as string)])) as PublicSubmission["balanceProof"],
  rangeProofs: [], signature: vector.expected.signature };
const point = { number: 1n, hash: hash("a"), mode: "local-simulated" as const };

function history(status: "ready" | "executed" | "unconfirmed" = "ready"): HistoryPort {
  const complete = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  return {
    getFinalizedCheckpoint: async () => point,
    getContext: async () => complete(context),
    getCanonicalHeader: async () => complete({ number: point.number, hash: point.hash }),
    getOperations: async () => complete([]),
    getUtxo: async () => complete({ exists: false }),
    getOperationSuccess: async () => complete({ executed: status === "executed" }),
    getLatestHeader: async () => status === "unconfirmed" ? null : point,
    getLatestUtxo: async () => complete({ exists: false }),
    getLatestOperationSuccess: async () => complete({ executed: status === "executed" }),
  };
}

function wallet(fail = false) {
  const sent: unknown[] = [];
  const mock = {
    getChainId: async () => 31337,
    estimateGas: async () => 100000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
    getBalance: async () => 1000000000n,
    getTransactionCount: async () => 7,
    sendTransaction: async (arg: unknown) => { sent.push(arg); if (fail) throw new Error("secret provider URL"); return hash("b"); },
  } as unknown as SubmissionWallet;
  return { mock, sent };
}

it("prepares a locally signed raw without calling sendTransaction", async () => {
  const { mock, sent } = wallet();
  const account = privateKeyToAccount(`0x${"04".repeat(32)}`);
  const prepared = await prepareSignedRaw(verified, history(), { wallet: mock, account }, submission);
  expect(prepared.raw).toMatch(/^0x[0-9a-f]+$/);
  expect(prepared.hash).toBe(keccak256(prepared.raw));
  expect(prepared.nonce).toBe(7);
  expect(sent).toEqual([]);
});

it("encodes the published Pool request without changing values or receipt bytes", () => {
  const call = encodePoolSubmission(submission);
  expect(call.value).toBe(request.d);
  const decoded = decodeFunctionData({ abi: poolAbi, data: call.data });
  expect(decoded.functionName).toBe("deposit");
  expect((decoded.args?.[0] as unknown as { outputs: readonly { packet: Hex }[] }).outputs[0]?.packet).toBe(request.outputs[0]?.packet);
  expect(operationId(context, request)).toBe(vector.expected.operationId);
});

it.each(["VEC-07-POOL-TRANSFER-PARTIAL", "VEC-07-POOL-WITHDRAW-FULL"])(
  "encodes independent %s calldata with zero ETH value", id => {
    const item = JSON.parse(readFileSync("tests/vectors/cases/pool-operations.json", "utf8"))
      .find((entry: { id: string }) => entry.id === id);
    const input = item.input;
    const proof = item.expected.balanceProof;
    const publicOperation: PublicSubmission = { request: { kind: input.kind, owner: input.owner,
      salt: input.salt, inputIds: input.inputIds,
      outputs: input.outputs.map((output: any) => ({ owner: output.owner,
        commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) },
        receiptFormat: 1, packet: output.packet })), d: BigInt(input.d), w: BigInt(input.w),
      destination: input.destination },
    balanceProof: { Rx: BigInt(proof.Rx), Ry: BigInt(proof.Ry), s: BigInt(proof.s) },
    rangeProofs: item.expected.rangeProofs.map((range: any) => ({
      coords: range.coords.map(BigInt), scalars: range.scalars.map(BigInt),
      ls: range.ls.map(BigInt), rs: range.rs.map(BigInt),
    })), signature: item.expected.signature };
    const call = encodePoolSubmission(publicOperation);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: poolAbi, data: call.data });
    expect(decoded.functionName).toBe(input.kind === 1 ? "transfer" : "withdraw");
    expect(operationId(context, publicOperation.request)).toBe(item.expected.operationId);
  });

it("preflights and submits exactly once, preserving an uncertain send", async () => {
  const normal = wallet();
  const result = await submitPublicOperation(verified, history(), normal.mock, request.owner, submission,
    { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n });
  expect(result.attempt).toEqual({ outer: "pending", txHash: hash("b") });
  expect(normal.sent).toHaveLength(1);
  const dropped = wallet(true);
  const uncertain = await submitPublicOperation(verified, history(), dropped.mock, request.owner, submission,
    { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n });
  expect(uncertain.operationId).toBe(vector.expected.operationId);
  expect(uncertain.attempt).toEqual({ outer: "unconfirmed" });
  expect(uncertain.diagnostic).toBe("SUBMISSION_UNKNOWN");
  expect(dropped.sent).toHaveLength(1);
});

it("persists the final send intent before broadcasting and stops on unknown durability", async () => {
  const sender = wallet();
  const options = { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };
  const captured: PreparedSend[] = [];
  await expect(submitPublicOperation(verified, history(), sender.mock, request.owner, submission, options,
    { persistPrepared: async intent => { captured.push(structuredClone(intent)); return "unknown"; } }))
    .rejects.toMatchObject({ code: "STORAGE_UNKNOWN" });
  expect(sender.sent).toHaveLength(0);
  const result = await submitPublicOperation(verified, history(), sender.mock, request.owner, submission, options,
    { persistPrepared: async intent => { captured.push(structuredClone(intent)); return "saved"; } });
  expect(sender.sent).toHaveLength(1);
  expect(captured[1]).toMatchObject({ operationId: result.operationId, account: request.owner,
    calldata: result.calldata, value: result.value, ...options });
  expect(sender.sent[0]).toMatchObject({ account: captured[1]!.account, to: context.pool,
    data: captured[1]!.calldata, value: captured[1]!.value, gas: captured[1]!.gas,
    nonce: captured[1]!.nonce, maxFeePerGas: captured[1]!.maxFeePerGas,
    maxPriorityFeePerGas: captured[1]!.maxPriorityFeePerGas });
  const failed = wallet(true);
  const uncertain = await submitPublicOperation(verified, history(), failed.mock, request.owner, submission, options,
    { persistPrepared: async () => "saved" });
  expect(uncertain.diagnostic).toBe("SUBMISSION_UNKNOWN");
  expect(uncertain.calldata).toBe(result.calldata);
  expect(failed.sent).toHaveLength(1);
});

it("persists fee replacements before another broadcast", async () => {
  const sender = wallet();
  const prior = await submitPublicOperation(verified, history(), sender.mock, request.owner, submission,
    { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n });
  await expect(replaceSubmissionFee(verified, history(), sender.mock, prior,
    { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n },
    { persistPrepared: async () => "unknown" })).rejects.toMatchObject({ code: "STORAGE_UNKNOWN" });
  expect(sender.sent).toHaveLength(1);
  const intents: PreparedSend[] = [];
  const result = await replaceSubmissionFee(verified, history(), sender.mock, prior,
    { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n },
    { persistPrepared: async intent => { intents.push(structuredClone(intent)); return "saved"; } });
  expect(sender.sent).toHaveLength(2);
  expect(intents[0]).toMatchObject({ calldata: prior.calldata, value: prior.value, nonce: prior.nonce,
    maxFeePerGas: 120n, maxPriorityFeePerGas: 3n });
  expect(result.attempts).toHaveLength(2);
});

it("rejects invalid preflight and replaces fees only for the same attempt", async () => {
  const sender = wallet();
  await expect(submitPublicOperation(verified, history("unconfirmed"), sender.mock,
    request.owner, submission, {})).rejects.toMatchObject({ code: "GAP" });
  const first = await submitPublicOperation(verified, history(), sender.mock,
    request.owner, submission, { gas: 100000n, nonce: 7, maxFeePerGas: 100n, maxPriorityFeePerGas: 2n });
  const second = await replaceSubmissionFee(verified, history(), sender.mock, first,
    { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n });
  expect(second.operationId).toBe(first.operationId);
  expect(second.calldata).toBe(first.calldata);
  expect(second.nonce).toBe(first.nonce);
  expect(second.attempts).toEqual([first.attempt, second.attempt]);
  expect(sender.sent[1]).toMatchObject({ account: request.owner, to: context.pool,
    data: first.calldata, value: first.value, gas: first.gas, nonce: first.nonce });
  await expect(replaceSubmissionFee(verified, history(), sender.mock, first,
    { maxFeePerGas: 105n, maxPriorityFeePerGas: 2n })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await expect(replaceSubmissionFee(verified, history(), sender.mock,
    { ...first, calldata: "0x1234" }, { maxFeePerGas: 120n, maxPriorityFeePerGas: 3n }))
    .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(sender.sent).toHaveLength(2);
});

it("rejects a wrong chain, bad signature, insufficient ETH, and invalid options before sending", async () => {
  const sender = wallet();
  await expect(submitPublicOperation(verified, history(), { ...sender.mock, getChainId: async () => 1 },
    request.owner, submission, {})).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
  await expect(submitPublicOperation(verified, history(), sender.mock, request.owner,
    { ...submission, signature: `0x${"00".repeat(65)}` }, {}))
    .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  await expect(submitPublicOperation(verified, history(), { ...sender.mock, getBalance: async () => 1n },
    request.owner, submission, {})).rejects.toMatchObject({ code: "SIMULATION_FAILED" });
  await expect(submitPublicOperation(verified, history(), sender.mock, request.owner,
    submission, { gas: 0n })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(sender.sent).toHaveLength(0);
});
