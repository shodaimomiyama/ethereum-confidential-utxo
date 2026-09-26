import { describe, expect, it } from "vitest";
import cases from "../../../tests/vectors/cases/balance.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { balanceChallengeTrace, balanceWitness, computeBalancePoint, generateBalanceProof, proveBalanceWithSource } from "../src/balance.js";
import { G } from "../src/fixed-parameters.js";
import { add, mul, pointPair, Q, samePoint } from "../src/group.js";

const point = (pair: readonly string[]) => ({ x: BigInt(pair[0]!), y: BigInt(pair[1]!) });
type ProofCase = {
  id: string;
  input: {
    chainId: string; pool: string; operationId: string; d: string; w: string; testNonce: string;
    inputOpenings: { blinding: string }[]; outputOpenings: { blinding: string }[];
    inputCommitments: string[][]; outputCommitments: string[][];
    proof: { R: string[]; s: string };
  };
  expected: {
    X: string[];
    challengeTrace: { counter: string; preimage: string; candidate: string; accepted: boolean }[];
  };
};
const proofCases = cases.filter((entry) => entry.expected.decision === "accept" && "testNonce" in entry.input) as unknown as ProofCase[];

describe("Schnorr balance proof", () => {
  it("matches all independent balance vectors and challenge preimages", () => {
    for (const vector of proofCases) {
      const input = vector.input;
      const X = computeBalancePoint(
        input.inputCommitments.map(point), input.outputCommitments.map(point), BigInt(input.d), BigInt(input.w),
      );
      const x = balanceWitness(
        input.inputOpenings.map((value) => BigInt(value.blinding)),
        input.outputOpenings.map((value) => BigInt(value.blinding)),
      );
      expect(pointPair(X).map(String)).toEqual(vector.expected.X);
      const proof = proveBalanceWithSource({
        X, x, chainId: BigInt(input.chainId), pool: hexBytes(input.pool),
        operationId: hexBytes(input.operationId),
      }, { next: () => BigInt(input.testNonce) });
      expect([proof.Rx.toString(), proof.Ry.toString(), proof.s.toString()])
        .toEqual([...input.proof.R, input.proof.s]);
      const trace = balanceChallengeTrace(BigInt(input.chainId), hexBytes(input.pool), hexBytes(input.operationId), X, { x: proof.Rx, y: proof.Ry });
      expect(trace.map((step) => ({ ...step, counter: String(step.counter), candidate: String(step.candidate) })))
        .toEqual(vector.expected.challengeTrace);
      expect(samePoint(mul(G, proof.s), add({ x: proof.Rx, y: proof.Ry }, mul(X, trace.at(-1)!.candidate)))).toBe(true);
    }
  });

  it("permits identity X but refuses zero nonce and witness mismatch", () => {
    const vector = proofCases.find((entry) => entry.id === "VEC-05-TRANSFER-MERGE-IDENTITY-X")!;
    const input = vector.input;
    const X = computeBalancePoint(input.inputCommitments.map(point), input.outputCommitments.map(point), 0n, 0n);
    const x = balanceWitness(input.inputOpenings.map((value) => BigInt(value.blinding)), input.outputOpenings.map((value) => BigInt(value.blinding)));
    expect([X.x, X.y, x]).toEqual([0n, 0n, 0n]);
    const args = { X, x, chainId: 31337n, pool: hexBytes(input.pool), operationId: hexBytes(input.operationId) };
    const publicProof = generateBalanceProof(args);
    const publicR = { x: publicProof.Rx, y: publicProof.Ry };
    const publicChallenge = balanceChallengeTrace(args.chainId, args.pool, args.operationId, X, publicR).at(-1)!.candidate;
    expect(samePoint(mul(G, publicProof.s), add(publicR, mul(X, publicChallenge)))).toBe(true);
    expect(() => proveBalanceWithSource(args, { next: () => 0n })).toThrowError("SCALAR_EXHAUSTED:scalar");
    expect(() => proveBalanceWithSource({ ...args, x: 1n }, { next: () => 1n })).toThrowError("INPUT:balance.witness");
  });

  it("validates public context and binds chain, pool, and operation", () => {
    const input = proofCases[0]!.input;
    const X = point(proofCases[0]!.expected.X);
    const args = { X, x: Q - 3n, chainId: 31337n, pool: hexBytes(input.pool), operationId: hexBytes(input.operationId) };
    expect(() => generateBalanceProof({ ...args, pool: new Uint8Array(19) })).toThrowError("INPUT:balance.context");
    expect(() => generateBalanceProof({ ...args, operationId: new Uint8Array(31) })).toThrowError("INPUT:balance.context");
    const R = point(input.proof.R);
    const original = balanceChallengeTrace(args.chainId, args.pool, args.operationId, X, R).at(-1)!.candidate;
    expect(balanceChallengeTrace(args.chainId + 1n, args.pool, args.operationId, X, R).at(-1)!.candidate).not.toBe(original);
    const pool = args.pool.slice(); pool[0]! ^= 1;
    expect(balanceChallengeTrace(args.chainId, pool, args.operationId, X, R).at(-1)!.candidate).not.toBe(original);
    const operation = args.operationId.slice(); operation[0]! ^= 1;
    expect(balanceChallengeTrace(args.chainId, args.pool, operation, X, R).at(-1)!.candidate).not.toBe(original);
  });

  it("treats a zero response as canonical but rejects a false equation", () => {
    const entry = cases.find((candidate) => candidate.id === "VEC-05-S-ZERO")! as unknown as ProofCase;
    const input = entry.input;
    const X = computeBalancePoint(
      input.inputCommitments.map(point), input.outputCommitments.map(point), BigInt(input.d), BigInt(input.w),
    );
    const R = point(input.proof.R);
    const challenge = balanceChallengeTrace(BigInt(input.chainId), hexBytes(input.pool), hexBytes(input.operationId), X, R).at(-1)!.candidate;
    expect(0n >= 0n && 0n < Q).toBe(true);
    expect(samePoint(mul(G, 0n), add(R, mul(X, challenge)))).toBe(false);
  });
});
