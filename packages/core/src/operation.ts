import { balanceWitness, commit, computeBalancePoint, CryptoFailure, encryptReceipt, generateBalanceProof, generateRangeProof, M, randomBlinding } from "@confidential-utxo/crypto";
import type { Opening } from "@confidential-utxo/crypto";
import { bytesToHex, hexToBytes, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { verifyRecipientInfo } from "./authorization.js";
import type { RecipientInfo } from "./authorization.js";
import { operationId, outputId, receiptInfo, validateOperationShape } from "./encoding.js";
import { CoreFailure } from "./errors.js";
import { selectInputs } from "./selection.js";
import type { Context, LocalDraft, OperationRequest, OwnedUtxo } from "./types.js";

type CommonIntent = { owner: Address; amount: bigint };
export type BuildIntent = CommonIntent & (
  | { kind: 0; recipient: RecipientInfo }
  | { kind: 1; recipient: RecipientInfo; changeRecipient?: RecipientInfo; explicitIds?: Hex[] }
  | { kind: 2; destination: Address; changeRecipient?: RecipientInfo; explicitIds?: Hex[] }
);
export type BuildDependencies = { inputs: OwnedUtxo[]; randomSalt(): Uint8Array };
export type PublicSubmission = Pick<LocalDraft, "request" | "balanceProof" | "rangeProofs"> & { signature: Hex };
function invalid(): never { throw new CoreFailure("INVALID_INPUT", "operation"); }
function freezeTree(value: object): void {
  Object.values(value).forEach(child => { if (child !== null && typeof child === "object") freezeTree(child); });
  Object.freeze(value);
}
function safeFailure(error: unknown): never {
  if (error instanceof CoreFailure) throw error;
  if (error instanceof CryptoFailure) throw new CryptoFailure(error.code, "operation");
  throw new CoreFailure("CRYPTO", "operation");
}
function publicRequest(request: OperationRequest): OperationRequest {
  return { kind: request.kind, owner: request.owner, salt: request.salt, inputIds: [...request.inputIds],
    outputs: request.outputs.map(o => ({ owner: o.owner, commitment: { x: o.commitment.x, y: o.commitment.y }, receiptFormat: o.receiptFormat, packet: o.packet })),
    d: request.d, w: request.w, destination: request.destination };
}
function proofs(context: Context, request: OperationRequest, openings: Opening[], inputOpenings: Opening[]) {
  validateOperationShape(request);
  if (!Array.isArray(openings) || !Array.isArray(inputOpenings) || openings.length !== request.outputs.length || inputOpenings.length !== request.inputIds.length) invalid();
  const outputs = openings.map(commit);
  if (outputs.some((c, i) => c.x !== request.outputs[i]!.commitment.x || c.y !== request.outputs[i]!.commitment.y)) invalid();
  const inputs = inputOpenings.map(commit);
  if (inputOpenings.reduce((s, o) => s + o.amount, request.d) !== openings.reduce((s, o) => s + o.amount, request.w)) invalid();
  const id = operationId(context, request);
  const rangeProofs = request.kind === 0 ? [] : openings.map((opening, i) => generateRangeProof(opening, hexToBytes(id), BigInt(i)));
  const balanceProof = generateBalanceProof({ X: computeBalancePoint(inputs, outputs, request.d, request.w),
    x: balanceWitness(inputOpenings.map(o => o.blinding), openings.map(o => o.blinding)),
    chainId: context.chainId, pool: hexToBytes(context.pool), operationId: hexToBytes(id) });
  return { operationId: id, outputIds: outputs.map((_, i) => outputId(id, i)), rangeProofs, balanceProof };
}

/** Builds local secret state. Submission still requires persistence and a current-state preflight. */
export async function buildOperation(intent: BuildIntent, context: Context, dependencies: BuildDependencies): Promise<LocalDraft> {
  try {
    const plan = structuredClone(intent);
    const ctx = structuredClone(context);
    const candidates = structuredClone(dependencies.inputs);
    if (![0, 1, 2].includes(plan.kind) || typeof plan.amount !== "bigint" || plan.amount < 1n || plan.amount > (plan.kind === 2 ? 2n * M : M)) invalid();
    const inputs = plan.kind === 0 ? [] : selectInputs(ctx, candidates, { kind: plan.kind, owner: plan.owner, amount: plan.amount, ...(plan.explicitIds === undefined ? {} : { explicitIds: plan.explicitIds }) });
    for (const input of inputs) {
      const c = commit(input.opening);
      if (c.x !== input.commitment.x || c.y !== input.commitment.y) invalid();
    }
    const outputPlans: { amount: bigint; recipient: RecipientInfo }[] = [];
    if (plan.kind !== 2) outputPlans.push({ amount: plan.amount, recipient: plan.recipient });
    const change = plan.kind === 0 ? 0n : inputs.reduce((s, input) => s + input.opening.amount, -plan.amount);
    if (plan.kind !== 0 && change > 0n) {
      if (!plan.changeRecipient) invalid();
      outputPlans.push({ amount: change, recipient: plan.changeRecipient });
    }
    for (let i = 0; i < outputPlans.length; i++) {
      const recipient = outputPlans[i]!.recipient;
      await verifyRecipientInfo(ctx, recipient, plan.kind === 1 && i === 0 ? recipient.owner : plan.owner);
    }
    let saltBytes: Uint8Array;
    try { saltBytes = dependencies.randomSalt(); }
    catch { throw new CoreFailure("CRYPTO", "operation.salt"); }
    if (!(saltBytes instanceof Uint8Array) || saltBytes.length !== 32) invalid();
    const openings = outputPlans.map(output => ({ amount: output.amount, blinding: randomBlinding() }));
    const request: OperationRequest = { kind: plan.kind, owner: plan.owner, salt: bytesToHex(saltBytes), inputIds: inputs.map(input => input.id),
      outputs: outputPlans.map((output, i) => ({ owner: output.recipient.owner, commitment: commit(openings[i]!), receiptFormat: 1, packet: "0x" })),
      d: plan.kind === 0 ? plan.amount : 0n, w: plan.kind === 2 ? plan.amount : 0n, destination: plan.kind === 2 ? plan.destination : zeroAddress };
    for (let i = 0; i < request.outputs.length; i++) {
      request.outputs[i]!.packet = bytesToHex(await encryptReceipt({ recipientPublicKey: hexToBytes(outputPlans[i]!.recipient.receivePublicKey), info: hexToBytes(receiptInfo(ctx, request, i)), opening: openings[i]! }));
    }
    validateOperationShape(request);
    freezeTree(request);
    freezeTree(ctx);
    const inputOpenings = inputs.map(input => ({ amount: input.opening.amount, blinding: input.opening.blinding }));
    return { context: ctx, request, openings, inputOpenings, ...proofs(ctx, request, openings, inputOpenings) };
  } catch (error) { safeFailure(error); }
}

/** Explicitly replaces proofs while retaining the operation, receipts and any owner signature. */
export function regenerateProofs(draft: LocalDraft): LocalDraft {
  try {
    const snapshot = structuredClone(draft);
    validateOperationShape(snapshot.request);
    if (operationId(snapshot.context, snapshot.request) !== snapshot.operationId || snapshot.outputIds.length !== snapshot.request.outputs.length || snapshot.outputIds.some((id, i) => id !== outputId(snapshot.operationId, i))) invalid();
    const regenerated = proofs(snapshot.context, snapshot.request, snapshot.openings, snapshot.inputOpenings);
    freezeTree(snapshot.request);
    freezeTree(snapshot.context);
    return { ...snapshot, ...regenerated };
  } catch (error) { safeFailure(error); }
}

/** Projects public fields only; this is not the persistence/preflight submission gate. */
export function toPublicSubmission(draft: LocalDraft): PublicSubmission {
  validateOperationShape(draft.request);
  if (!draft.signature || !/^0x[0-9a-fA-F]{130}$/.test(draft.signature)) invalid();
  if (operationId(draft.context, draft.request) !== draft.operationId) invalid();
  return { request: publicRequest(draft.request), balanceProof: { Rx: draft.balanceProof.Rx, Ry: draft.balanceProof.Ry, s: draft.balanceProof.s },
    rangeProofs: draft.rangeProofs.map(proof => ({ coords: [...proof.coords], scalars: [...proof.scalars], ls: [...proof.ls], rs: [...proof.rs] })), signature: draft.signature };
}
