import { readFileSync } from "node:fs";
import { commit } from "@confidential-utxo/crypto";
import { afterEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import * as syncModule from "../src/sync.js";
import { authorizationTypedData, buildOperation, operationId, preflightSubmission, prepareSubmission, trackAttempt } from "../src/index.js";
import type { Context, HistoryPort, LocalDraft, ObservedOperation, OperationRequest, RecipientInfo } from "../src/index.js";
afterEach(() => vi.restoreAllMocks());
const hex = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const v = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/authorization.json", import.meta.url), "utf8")).find((v: { id: string }) => v.id === "VEC-02-RECIPIENT-SIGNATURE");
const account = privateKeyToAccount(v.input.testOnlyPrivateKey);
const context: Context = { chainId: 31337n, pool: v.input.pool, deploymentBlock: 0n, verifier: v.input.pool, parametersHash: hex(0), finalityMode: "finalized" };
const point = { number: 10n, hash: hex(10), mode: "finalized" as const };
const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
const request: OperationRequest = { kind: 2, owner: account.address, salt: hex(1), inputIds: [hex(2)], outputs: [], d: 0n, w: 10n, destination: account.address };
const id = operationId(context, request);
function history(): HistoryPort {
  return {
    getFinalizedCheckpoint: vi.fn(async () => point), getContext: vi.fn(async () => bound(context)),
    getCanonicalHeader: vi.fn(async number => bound({ number, hash: point.hash })),
    getOperations: vi.fn(async () => bound([])), getUtxo: vi.fn(async () => bound({ exists: true })),
    getOperationSuccess: vi.fn(async () => bound({ executed: false })), getLatestHeader: vi.fn(async () => point),
    getLatestUtxo: vi.fn(async () => bound({ exists: true, owner: account.address, commitment: commit({ amount: 10n, blinding: 2n }) })),
    getLatestOperationSuccess: vi.fn(async () => bound({ executed: false })),
  };
}
function success(req = request): ObservedOperation {
  return { request: req, outputLogs: [], success: { operationId: operationId(context, req), blockNumber: point.number, blockHash: point.hash, transactionHash: hex(20), transactionIndex: 0, logIndex: 0 } };
}
it("AC-08: does not infer logical success or receipt ownership from outer receipt success", () => {
  const result = trackAttempt(id, { txHash: hex(3), outer: "success", operation: "unconfirmed" }, []);
  expect(result.operation).toBe("unconfirmed");
  expect(result.receipt).toBe("unconfirmed");
  expect(result.attempts).toHaveLength(1);
});
it("preserves failed and successful attempts while separately verifying operation success", () => {
  const first = trackAttempt(id, { txHash: hex(3), outer: "failed", failure: "OUTER_REVERT" }, []);
  const result = trackAttempt(id, { txHash: hex(4), outer: "success", evidence: { context, checkpoint: point, event: success(), record: bound({ executed: true }), header: bound(point) } }, first);
  expect(result.attempts.map(a => a.outer)).toEqual(["failed", "success"]);
  expect(result.operation).toBe("executed");
  expect(result.receipt).toBe("unconfirmed");
});
it("rejects incomplete or mismatched logical success evidence", () => {
  for (const record of [bound({ executed: false }), { ...bound({ executed: true }), blockHash: hex(99) }]) {
    expect(trackAttempt(id, { outer: "success", evidence: { context, checkpoint: point, event: success(), record, header: bound(point) } }, []).operation).toBe("unconfirmed");
  }
});
it("requires complete latest history even when isOperationExecuted is false", async () => {
  const h = history();
  vi.mocked(h.getOperations).mockResolvedValue({ complete: false, reason: "GAP" });
  await expect(preflightSubmission(context, request, { history: h })).resolves.toMatchObject({ status: "unconfirmed" });
});
it("permits an explicit attempt only with complete pinned history and unspent inputs", async () => {
  await expect(preflightSubmission(context, request, { history: history() })).resolves.toMatchObject({ status: "ready" });
});
it.each(["missing", "hash", "spent", "same", "owner", "rpc"])("handles latest input %s", async mode => {
  const h = history();
  if (mode === "missing") vi.mocked(h.getLatestUtxo).mockResolvedValue(bound({ exists: false }));
  if (mode === "hash") vi.mocked(h.getLatestUtxo).mockResolvedValue({ ...bound({ exists: true }), blockHash: hex(9) });
  if (mode === "spent" || mode === "same") vi.mocked(h.getLatestUtxo).mockResolvedValue(bound({ exists: true, consumedBy: mode === "spent" ? hex(30) : id }));
  if (mode === "owner") vi.mocked(h.getLatestUtxo).mockResolvedValue(bound({ exists: true, owner: context.pool }));
  if (mode === "rpc") vi.mocked(h.getLatestUtxo).mockRejectedValue(new Error("secret"));
  await expect(preflightSubmission(context, request, { history: h })).resolves.toMatchObject({ status: mode === "spent" ? "conflict" : "unconfirmed" });
});
it("requires event and record agreement for executed status", async () => {
  const h = history();
  vi.mocked(h.getLatestOperationSuccess).mockResolvedValue(bound({ executed: true }));
  await expect(preflightSubmission(context, request, { history: h })).resolves.toMatchObject({ status: "unconfirmed" });
  vi.mocked(h.getOperations).mockResolvedValue(bound([success()]));
  await expect(preflightSubmission(context, request, { history: h })).resolves.toMatchObject({ status: "executed" });
  vi.mocked(h.getLatestOperationSuccess).mockResolvedValue(bound({ executed: false }));
  await expect(preflightSubmission(context, request, { history: h })).resolves.toMatchObject({ status: "unconfirmed" });
});
async function draft(): Promise<LocalDraft> {
  const recipient: RecipientInfo = { ...v.input, chainId: BigInt(v.input.chainId) };
  const d = await buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient }, context, { inputs: [], randomSalt: () => new Uint8Array(32).fill(4) });
  return { ...d, signature: await account.signTypedData(authorizationTypedData(context, d.request)) };
}
function ports(h = history()) { return { history: h, storage: { saveDraft: vi.fn(async (_draft: LocalDraft): Promise<"saved" | "unknown"> => "saved") }, keys: { getKey: vi.fn(async () => new Uint8Array(32)) } }; }
it("saves and rechecks even zero-input deposits on every explicit preparation", async () => {
  const d = await draft(); const p = ports();
  expect((await prepareSubmission(d, p)).status).toBe("ready");
  expect((await prepareSubmission(d, p)).status).toBe("ready");
  expect(p.storage.saveDraft).toHaveBeenCalledTimes(2);
  expect(p.history.getLatestOperationSuccess).toHaveBeenCalledTimes(2);
  expect(p.history.getFinalizedCheckpoint).toHaveBeenCalledTimes(2);
});
it.each(["unknown", "throw"])("AC-09: VEC-02-RECIPIENT-SIGNATURE recipient withholds submission after %s save", async mode => {
  const p = ports();
  if (mode === "unknown") p.storage.saveDraft.mockImplementation(async () => "unknown");
  else p.storage.saveDraft.mockRejectedValue(new Error("opening-secret"));
  const result = await prepareSubmission(await draft(), p);
  expect(result).toEqual({ status: "storage-unknown" });
  expect(p.history.getLatestHeader).not.toHaveBeenCalled();
});
it("projects only public fields", async () => {
  const d = await draft(); const p = ports();
  const result = await prepareSubmission(d, p);
  expect(result.status).toBe("ready");
  if (result.status === "ready") {
    expect(Object.keys(result.submission).sort()).toEqual(["balanceProof", "rangeProofs", "request", "signature"]);
    expect(result.submission.request.salt).toBe(d.request.salt);
  }
});
it("AC-09: rejects restored draft ID, openings and signature tampering without leaking data", async () => {
  const d = await draft();
  for (const bad of [{ ...d, operationId: hex(999) }, { ...d, openings: [] }, { ...d, outputIds: [] }, { ...d, signature: "0x" as Hex }]) {
    const p = ports();
    expect(await prepareSubmission(bad, p)).toEqual({ status: "invalid" });
    expect(p.storage.saveDraft).not.toHaveBeenCalled();
  }
});
it("stops restored drafts when synchronization is incomplete", async () => {
  const p = ports(); vi.mocked(p.history.getFinalizedCheckpoint).mockResolvedValue(null);
  expect(await prepareSubmission(await draft(), p)).toMatchObject({ status: "unconfirmed" });
  expect(p.storage.saveDraft).not.toHaveBeenCalled();
});
it("matches restored input openings against fresh chain commitments", async () => {
  const opening = { amount: 10n, blinding: 2n };
  const d = await buildOperation({ kind: 2, owner: account.address, amount: 10n, destination: account.address }, context, { randomSalt: () => new Uint8Array(32), inputs: [{ id: hex(2), owner: account.address, opening, commitment: commit(opening), checkpoint: point, status: "available", chainId: context.chainId, pool: context.pool }] });
  d.signature = await account.signTypedData(authorizationTypedData(context, d.request));
  const p = ports();
  vi.spyOn(syncModule, "synchronize").mockResolvedValue({ status: "complete", receiptFailures: [], checkpoint: point, availableWei: 10n, utxos: [{ id: hex(2), owner: account.address, opening, commitment: commit(opening), checkpoint: point, status: "available", chainId: context.chainId, pool: context.pool }] });
  expect((await prepareSubmission(d, p)).status).toBe("ready");
  vi.mocked(p.history.getLatestUtxo).mockResolvedValue(bound({ exists: true, owner: account.address, commitment: commit({ ...opening, blinding: 3n }) }));
  expect(await prepareSubmission(d, p)).toMatchObject({ status: "unconfirmed" });
});

it("does not prepare from a synchronization checkpoint off the latest ancestry", async () => {
  const p = ports();
  vi.spyOn(syncModule, "synchronize").mockResolvedValue({ status: "complete", receiptFailures: [], checkpoint: { ...point, number: 9n, hash: hex(9) }, availableWei: 0n, utxos: [] });
  expect(await prepareSubmission(await draft(), p)).toMatchObject({ status: "unconfirmed" });
});
it("rechecks the latest operation after a successful save before returning public data", async () => {
  const d = await draft(); const p = ports();
  p.storage.saveDraft.mockImplementation(async () => {
    vi.mocked(p.history.getLatestOperationSuccess).mockResolvedValue(bound({ executed: true }));
    vi.mocked(p.history.getOperations).mockResolvedValue(bound([success(d.request)]));
    return "saved";
  });
  expect(await prepareSubmission(d, p)).toEqual({ status: "executed", latest: { number: point.number, hash: point.hash } });
});
it.each(["no-header", "context", "success-hash", "reorg"])("fails closed for %s", async mode => {
  const h = history();
  if (mode === "no-header") vi.mocked(h.getLatestHeader).mockResolvedValue(null);
  if (mode === "context") vi.mocked(h.getContext).mockResolvedValue(bound({ ...context, chainId: 1n }));
  if (mode === "success-hash") vi.mocked(h.getLatestOperationSuccess).mockResolvedValue({ ...bound({ executed: false }), blockHash: hex(99) });
  if (mode === "reorg") vi.mocked(h.getCanonicalHeader).mockResolvedValue(bound({ number: point.number, hash: hex(99) }));
  expect(await preflightSubmission(context, request, { history: h })).toMatchObject({ status: "unconfirmed" });
});
it("updates the same attempt without carrying prior logical success across uncertain history", () => {
  const before = trackAttempt(id, { txHash: hex(20), outer: "success", evidence: { context, checkpoint: point, event: success(), record: bound({ executed: true }), header: bound(point) } }, []);
  const after = trackAttempt(id, { txHash: hex(20), outer: "unconfirmed", historyStatus: "uncertain" }, before);
  expect(after.operation).toBe("unconfirmed");
  expect(after.attempts).toHaveLength(1);
  expect(before.attempts[0]!.outer).toBe("success");
});

it("does not treat a mutated stored draft as confirmed persistence", async () => {
  const p = ports();
  p.storage.saveDraft.mockImplementation(async saved => { saved.request.salt = hex(999); return "saved"; });
  expect(await prepareSubmission(await draft(), p)).toEqual({ status: "storage-unknown" });
});

it("preserves adopted logical success when another outer attempt fails, and withdraws it on reorg", () => {
  const before = trackAttempt(id, { txHash: hex(20), outer: "success", evidence: { context, checkpoint: point, event: success(), record: bound({ executed: true }), header: bound(point) } }, []);
  const after = trackAttempt(id, { txHash: hex(21), outer: "failed" }, before);
  expect(after.operation).toBe("executed");
  expect(after.checkpoint).toEqual(point);
  expect(after.successEvidence).toEqual(before.successEvidence);
  expect(trackAttempt(id, { outer: "unconfirmed", historyStatus: "reorg" }, after).operation).toBe("unconfirmed");
  expect(trackAttempt(id, { outer: "unconfirmed", historyStatus: "uncertain" }, after).operation).toBe("unconfirmed");
});
it("returns latest evidence separately from finality in preflight and preparation", async () => {
  const p = ports();
  const latest = { number: 11n, hash: hex(11) };
  vi.mocked(p.history.getLatestHeader).mockResolvedValue(latest);
  vi.mocked(p.history.getContext).mockImplementation(async cp => ({ complete: true, blockHash: cp.hash, value: context }));
  vi.mocked(p.history.getOperations).mockImplementation(async (_from, cp) => ({ complete: true, blockHash: cp.hash, value: [] }));
  vi.mocked(p.history.getLatestOperationSuccess).mockResolvedValue({ complete: true, blockHash: latest.hash, value: { executed: false } });
  vi.mocked(p.history.getCanonicalHeader).mockImplementation(async (number, cp) => ({ complete: true, blockHash: cp.hash, value: { number, hash: number === 10n ? point.hash : latest.hash } }));
  const d = await draft();
  expect(await preflightSubmission(context, d.request, p)).toEqual({ status: "ready", latest });
  expect(await prepareSubmission(d, p)).toMatchObject({ status: "ready", latest });
});

it.each(["invalid", "incomplete", "mismatched"])("preserves verified success when a failed attempt carries %s replacement evidence", mode => {
  const evidence = { context, checkpoint: point, event: success(), record: bound({ executed: true }), header: bound(point) };
  const before = trackAttempt(id, { txHash: hex(20), outer: "success", evidence }, []);
  const record = mode === "incomplete"
    ? { complete: false as const, reason: "GAP" as const }
    : mode === "mismatched" ? { ...bound({ executed: true }), blockHash: hex(99) } : bound({ executed: false });
  const observation = { txHash: hex(21), outer: "failed" as const, evidence: { ...evidence, record } };
  const after = trackAttempt(id, observation, before);
  expect(after.operation).toBe("executed");
  expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after.successEvidence).toEqual(before.successEvidence);
  expect(after.attempts.map(a => a.outer)).toEqual(["success", "failed"]);
  expect(trackAttempt(id, { ...observation, historyStatus: "uncertain" }, before).operation).toBe("unconfirmed");
});
