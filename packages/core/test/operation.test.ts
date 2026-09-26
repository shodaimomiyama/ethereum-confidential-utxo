import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as crypto from "@confidential-utxo/crypto";
import { hashTypedData } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { authorizationTypedData, buildOperation, CoreFailure, operationId, regenerateProofs, toPublicSubmission } from "../src/index.js";
import type { Context, OwnedUtxo, RecipientInfo } from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/authorization.json", import.meta.url), "utf8"));
const vector = vectors.find((v: { id: string }) => v.id === "VEC-02-RECIPIENT-SIGNATURE");
const recipient = (): RecipientInfo => ({ ...vector.input, chainId: BigInt(vector.input.chainId) });
const account = privateKeyToAccount(vector.input.testOnlyPrivateKey);
const context: Context = { chainId: 31337n, pool: vector.input.pool, deploymentBlock: 0n, verifier: vector.input.pool, parametersHash: `0x${"00".repeat(32)}`, finalityMode: "finalized" };
const salt = () => new Uint8Array(32).fill(7);
function coin(amount = 10n): OwnedUtxo {
  const opening = { amount, blinding: 2n };
  return { id: `0x${"01".repeat(32)}`, owner: account.address, opening, commitment: crypto.commit(opening), checkpoint: { number: 1n, hash: `0x${"02".repeat(32)}`, mode: "finalized" }, status: "available", chainId: context.chainId, pool: context.pool };
}
afterEach(() => vi.restoreAllMocks());
it("builds a real 1 wei deposit and excludes secrets from public submission", async () => {
  const draft = await buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: recipient() }, context, { randomSalt: salt, inputs: [] });
  expect(draft.request.kind).toBe(0);
  expect(draft.request.outputs[0]!.packet).toHaveLength(226);
  expect(draft.rangeProofs).toHaveLength(0);
  expect(draft.balanceProof).toHaveProperty("s");
  expect(draft.operationId).toBe(operationId(context, draft.request));
  expect(() => toPublicSubmission(draft)).toThrow();
  const signature = await account.signTypedData(authorizationTypedData(context, draft.request));
  expect(Object.keys(toPublicSubmission({ ...draft, signature })).sort()).toEqual(["balanceProof", "rangeProofs", "request", "signature"]);
});
it("AC-04: VEC-02-RECIPIENT-SIGNATURE recipient supports 10 → 3 + 7 proof regeneration", async () => {
  const draft = await buildOperation({ kind: 1, owner: account.address, amount: 3n, recipient: recipient(), changeRecipient: recipient() }, context, { randomSalt: salt, inputs: [coin()] });
  expect(draft.request.kind).toBe(1);
  expect(draft.request.inputIds).toEqual([coin().id]);
  expect(draft.openings.map(o => o.amount)).toEqual([3n, 7n]);
  expect(draft.rangeProofs).toHaveLength(2);
  expect(draft.request.outputs.every(o => o.packet.length === 226)).toBe(true);
  const digest = hashTypedData(authorizationTypedData(context, draft.request));
  const next = regenerateProofs(draft);
  expect(next.request).toEqual(draft.request);
  expect(next.operationId).toBe(draft.operationId);
  expect(next.outputIds).toEqual(draft.outputIds);
  expect(next.openings).toEqual(draft.openings);
  expect(hashTypedData(authorizationTypedData(context, next.request))).toBe(digest);
  expect(next.balanceProof).not.toEqual(draft.balanceProof);
  expect(next.rangeProofs).not.toEqual(draft.rangeProofs);
  expect(() => regenerateProofs({ ...draft, inputOpenings: [] })).toThrow();
});
it("omits the recipient output on full withdrawal", async () => {
  const draft = await buildOperation({ kind: 2, owner: account.address, amount: 10n, destination: account.address }, context, { randomSalt: salt, inputs: [coin()] });
  expect(draft.request.outputs).toEqual([]);
  expect(draft.rangeProofs).toEqual([]);
});
it("verifies recipient signatures before encryption", async () => {
  const encrypt = vi.spyOn(crypto, "encryptReceipt");
  await expect(buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: { ...recipient(), signature: "0x" } }, context, { randomSalt: salt, inputs: [] })).rejects.toThrow();
  expect(encrypt).not.toHaveBeenCalled();
});
it.each(["scalar", "random"])("interrupts %s failure without returning a draft or leaking error details", async mode => {
  if (mode === "scalar") vi.spyOn(crypto, "generateBalanceProof").mockImplementation(() => { throw new crypto.CryptoFailure("SCALAR_EXHAUSTED", "scalar"); });
  const randomSalt = mode === "random" ? () => { throw new Error("secret value 987654"); } : salt;
  let result;
  try { result = await buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: recipient() }, context, { randomSalt, inputs: [] }); }
  catch (error) { expect(String(error)).not.toContain("987654"); expect(error).toHaveProperty("code", mode === "scalar" ? "SCALAR_EXHAUSTED" : "CRYPTO"); }
  expect(result).toBeUndefined();
});

type ApplicationVector = {
  id: string;
  input: { chainId: string; pool: Hex; kind: 0 | 1 | 2; owner: Hex; salt: Hex; inputIds: Hex[]; d: string; w: string; destination: Hex; outputs: { owner: Hex; Cx: string; Cy: string; receiptFormat: 1; packet: Hex }[] };
  expected: { operationId: Hex; outputIds: { hash: Hex }[]; authorizationSignature: Hex; authorizationDigest: Hex;
    balanceProof: { R: string[]; s: string }; rangeProofs: { coords: string[]; scalars: string[]; ls: string[]; rs: string[] }[] };
};
const applicationVectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/application-operation.json", import.meta.url), "utf8")) as ApplicationVector[];
it.each(applicationVectors)("AC-02: assembles independent fixed public fixture $id", ({ input, expected }) => {
  const request = { ...input, d: BigInt(input.d), w: BigInt(input.w), outputs: input.outputs.map(o => ({ owner: o.owner, commitment: { x: BigInt(o.Cx), y: BigInt(o.Cy) }, receiptFormat: o.receiptFormat, packet: o.packet })) };
  const ctx = { ...context, chainId: BigInt(input.chainId), pool: input.pool };
  const balanceProof = { Rx: BigInt(expected.balanceProof.R[0]!), Ry: BigInt(expected.balanceProof.R[1]!), s: BigInt(expected.balanceProof.s) };
  const rangeProofs = expected.rangeProofs.map(p => ({ coords: p.coords.map(BigInt), scalars: p.scalars.map(BigInt), ls: p.ls.map(BigInt), rs: p.rs.map(BigInt) }));
  const submission = toPublicSubmission({ context: ctx, request, operationId: expected.operationId, outputIds: expected.outputIds.map(o => o.hash), openings: [], inputOpenings: [], balanceProof, rangeProofs, signature: expected.authorizationSignature });
  expect(operationId(ctx, submission.request)).toBe(expected.operationId);
  expect(hashTypedData(authorizationTypedData(ctx, submission.request))).toBe(expected.authorizationDigest);
  expect(submission.balanceProof).toEqual(balanceProof);
  expect(submission.rangeProofs).toEqual(rangeProofs);
  expect(submission.request.outputs.map(o => o.packet)).toEqual(input.outputs.map(o => o.packet));
  expect(submission.request).not.toHaveProperty("chainId");
});
it("snapshots recipient, context and inputs before awaiting signature verification", async () => {
  const info = recipient();
  const ctx = { ...context };
  const input = coin();
  const encryption = vi.spyOn(crypto, "encryptReceipt");
  const originalInput = structuredClone(input);
  const promise = buildOperation({ kind: 1, owner: account.address, amount: 3n, recipient: info, changeRecipient: recipient() }, ctx, { randomSalt: salt, inputs: [input] });
  info.receivePublicKey = `0x${"00".repeat(32)}`;
  ctx.pool = account.address;
  input.opening = { amount: 99n, blinding: 99n };
  const draft = await promise;
  expect(draft.context).toEqual(context);
  expect(encryption).toHaveBeenCalledTimes(2);
  expect(draft.openings.map(o => o.amount)).toEqual([3n, 7n]);
  expect(draft.inputOpenings).toEqual([originalInput.opening]);
  expect(draft.request.inputIds).toEqual([originalInput.id]);
});
it("rejects altered or missing opening state and malformed adopted requests", async () => {
  const draft = await buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: recipient() }, context, { randomSalt: salt, inputs: [] });
  expect(() => regenerateProofs({ ...draft, openings: [] })).toThrow();
  expect(() => regenerateProofs({ ...draft, openings: [{ amount: 2n, blinding: draft.openings[0]!.blinding }] })).toThrow();
  const malformed = { ...draft.request, d: 0n };
  const adopted = { ...draft, request: malformed, operationId: operationId(context, malformed) };
  expect(() => regenerateProofs(adopted)).toThrow();
  expect(() => toPublicSubmission({ ...adopted, signature: `0x${"01".repeat(65)}` })).toThrow();
});
it("stops at range proof failure and never attempts balance proof or a retry", async () => {
  const range = vi.spyOn(crypto, "generateRangeProof").mockImplementation(() => { throw new crypto.CryptoFailure("SCALAR_EXHAUSTED", "scalar"); });
  const balance = vi.spyOn(crypto, "generateBalanceProof");
  await expect(buildOperation({ kind: 1, owner: account.address, amount: 3n, recipient: recipient(), changeRecipient: recipient() }, context, { randomSalt: salt, inputs: [coin()] })).rejects.toHaveProperty("code", "SCALAR_EXHAUSTED");
  expect(range).toHaveBeenCalledTimes(1);
  expect(balance).not.toHaveBeenCalled();
});
it("retains the owner signature during full withdrawal regeneration", async () => {
  const draft = await buildOperation({ kind: 2, owner: account.address, amount: 10n, destination: account.address }, context, { randomSalt: salt, inputs: [coin()] });
  const signature = await account.signTypedData(authorizationTypedData(context, draft.request));
  expect(regenerateProofs({ ...draft, signature }).signature).toBe(signature);
});

it("normalizes secret-bearing CoreFailure from the salt callback", async () => {
  const secret = "secret value 987654";
  const external = Object.assign(new CoreFailure("CRYPTO", secret), { opening: secret, cause: new Error(secret) });
  const randomSalt = () => { throw external; };
  const result = buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: recipient() }, context, { randomSalt, inputs: [] });
  await expect(result).rejects.toMatchObject({ code: "CRYPTO", stage: "operation.salt", message: "CRYPTO:operation.salt" });
  await result.catch(error => {
    expect(error).not.toBe(external);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("opening");
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
