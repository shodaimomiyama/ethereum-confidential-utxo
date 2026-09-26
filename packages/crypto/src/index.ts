import { parsePoint } from "./group.js";
import type { G1Point } from "./group.js";

export { commit, M, P, Q } from "./group.js";
export type { G1Point, Opening } from "./group.js";
export { CryptoFailure } from "./errors.js";
export type { CryptoFailureCode } from "./errors.js";
export { randomBlinding } from "./random.js";
export { generateRangeProof } from "./range/prove.js";
export type { RangeProof } from "./range/fold.js";
export { balanceWitness, computeBalancePoint, generateBalanceProof } from "./balance.js";
export type { BalanceProof, BalanceProofInput } from "./balance.js";
export { encryptReceipt, decryptReceipt } from "./receipt.js";
export type { EncryptReceiptInput, DecryptReceiptInput } from "./receipt.js";

/** Validates canonical commitment coordinates, allowing the identity for separate amount verification. */
export function validateCommitment(point: G1Point): void {
  parsePoint(point, true);
}
