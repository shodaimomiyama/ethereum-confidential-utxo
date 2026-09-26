import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToBigInt, concat, tag, word } from "./bytes.js";
import { CryptoFailure } from "./errors.js";
import { G, H, PARAMETERS_HASH_V3 } from "./fixed-parameters.js";
import { M, modq, mul, neg, parsePoint, pointBytes, Q, samePoint, sum, type G1Point } from "./group.js";
import { makeSecureScalarSource, sampleScalar, type ScalarSource } from "./random.js";

export type BalanceProof = Readonly<{ Rx: bigint; Ry: bigint; s: bigint }>;
export type BalanceProofInput = Readonly<{
  X: G1Point;
  x: bigint;
  chainId: bigint;
  pool: Uint8Array;
  operationId: Uint8Array;
}>;

export type BalanceChallengeStep = Readonly<{
  counter: number;
  preimage: string;
  candidate: bigint;
  accepted: boolean;
}>;

function validateContext(chainId: bigint, pool: Uint8Array, operationId: Uint8Array): void {
  if (chainId < 0n || chainId >= (1n << 256n) || pool.length !== 20 || operationId.length !== 32) {
    throw new CryptoFailure("INPUT", "balance.context");
  }
}

export function computeBalancePoint(
  inputCommitments: readonly G1Point[], outputCommitments: readonly G1Point[], deposit: bigint, withdraw: bigint,
): G1Point {
  if (inputCommitments.length > 2 || outputCommitments.length > 2 ||
      deposit < 0n || deposit > M || withdraw < 0n || withdraw > 2n * M) {
    throw new CryptoFailure("INPUT", "balance.amounts");
  }
  try {
    inputCommitments.forEach((point) => parsePoint(point, true));
    outputCommitments.forEach((point) => parsePoint(point, true));
    return sum(
      ...inputCommitments, mul(H, deposit),
      ...outputCommitments.map(neg), neg(mul(H, withdraw)),
    );
  } catch {
    throw new CryptoFailure("INPUT", "balance.commitments");
  }
}

export function balanceWitness(inputBlindings: readonly bigint[], outputBlindings: readonly bigint[]): bigint {
  if (inputBlindings.length > 2 || outputBlindings.length > 2 ||
      [...inputBlindings, ...outputBlindings].some((blinding) => blinding < 0n || blinding >= Q)) {
    throw new CryptoFailure("INPUT", "balance.blindings");
  }
  const incoming = inputBlindings.reduce((total, blinding) => total + blinding, 0n);
  const outgoing = outputBlindings.reduce((total, blinding) => total + blinding, 0n);
  return modq(incoming - outgoing);
}

export function balanceChallengeTrace(
  chainId: bigint, pool: Uint8Array, operationId: Uint8Array, X: G1Point, R: G1Point,
): BalanceChallengeStep[] {
  validateContext(chainId, pool, operationId);
  try {
    parsePoint(X, true);
    parsePoint(R, false);
  } catch {
    throw new CryptoFailure("INPUT", "balance.points");
  }
  const addressWord = concat(new Uint8Array(12), pool);
  const trace: BalanceChallengeStep[] = [];
  for (let counter = 0; counter < 256; counter++) {
    const preimage = concat(
      tag("ecu/balance-schnorr/bn254/v1"), word(chainId), addressWord,
      PARAMETERS_HASH_V3, operationId, pointBytes(G), pointBytes(X), pointBytes(R), word(BigInt(counter)),
    );
    const candidate = bytesToBigInt(keccak_256(preimage));
    const accepted = candidate > 0n && candidate < Q;
    trace.push({ counter, preimage: `0x${Buffer.from(preimage).toString("hex")}`, candidate, accepted });
    if (accepted) return trace;
  }
  throw new CryptoFailure("CHALLENGE_EXHAUSTED", "balance");
}

export function proveBalanceWithSource(input: BalanceProofInput, source: ScalarSource): BalanceProof {
  validateContext(input.chainId, input.pool, input.operationId);
  if (input.x < 0n || input.x >= Q) throw new CryptoFailure("INPUT", "balance.witness");
  try { parsePoint(input.X, true); }
  catch { throw new CryptoFailure("INPUT", "balance.witness"); }
  if (!samePoint(input.X, mul(G, input.x))) throw new CryptoFailure("INPUT", "balance.witness");
  const nonce = sampleScalar(() => source.next(), false);
  const R = mul(G, nonce);
  const challenge = balanceChallengeTrace(input.chainId, input.pool, input.operationId, input.X, R).at(-1)!.candidate;
  return { Rx: R.x, Ry: R.y, s: modq(nonce + challenge * input.x) };
}

export function generateBalanceProof(input: BalanceProofInput): BalanceProof {
  try { return proveBalanceWithSource(input, makeSecureScalarSource()); }
  catch (error) {
    if (error instanceof CryptoFailure) throw error;
    throw new CryptoFailure("INTERNAL", "balanceProof");
  }
}
