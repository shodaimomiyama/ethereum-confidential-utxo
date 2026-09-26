import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/cases/range-deterministic.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { Q, M, pointPair } from "../src/group.js";
import { buildRangeBody } from "../src/range/body.js";
import { testScalarSource } from "./support/controlled-random.js";

describe("v3 range body", () => {
  it("matches the independent deterministic proof before folding", () => {
    const vector = vectors[0]!;
    const body = buildRangeBody(
      { amount: BigInt(vector.input.amount), blinding: BigInt(vector.input.blinding) },
      hexBytes(vector.input.operationId), BigInt(vector.input.outputIndex),
      testScalarSource(hexBytes(vector.input.testScalarSeed)),
    );
    expect(pointPair(body.C_range)).toEqual(vector.expected.C_range.map(BigInt));
    expect(pointPair(body.A)).toEqual(vector.input.coords.slice(2, 4).map(BigInt));
    expect(pointPair(body.S)).toEqual(vector.input.coords.slice(4, 6).map(BigInt));
    expect(pointPair(body.T1)).toEqual(vector.input.coords.slice(6, 8).map(BigInt));
    expect(pointPair(body.T2)).toEqual(vector.input.coords.slice(8, 10).map(BigInt));
    expect([body.tauX, body.mu, body.t]).toEqual(vector.input.scalars.slice(0, 3).map(BigInt));
    expect(body.le).toHaveLength(64);
    expect(body.re).toHaveLength(64);
    expect(body.g).toHaveLength(64);
    expect(body.hAdjusted).toHaveLength(64);
    const inner = vector.input.transcriptTrace.stages.find((stage) => stage.stage === "inner")!;
    expect(pointPair(body.innerPoint)).toEqual(inner.P!.map(BigInt));
    expect(pointPair(body.uPoint)).toEqual(inner.uPoint!.map(BigInt));
    expect(body.transcript.stateHex()).toBe(inner.nextState);
  });

  it("handles the amount boundaries and rejects invalid openings", () => {
    const operation = new Uint8Array(32);
    const source = () => testScalarSource(new Uint8Array(32).fill(4));
    const identity = buildRangeBody({ amount: 1n, blinding: 0n }, operation, 0n, source());
    expect(pointPair(identity.C_range)).toEqual([0n, 0n]);
    const max = buildRangeBody({ amount: M, blinding: 42n }, operation, 0n, source());
    expect(max.le).toHaveLength(64);
    for (const opening of [{ amount: 0n, blinding: 0n }, { amount: M + 1n, blinding: 0n }, { amount: 1n, blinding: Q }]) {
      expect(() => buildRangeBody(opening, operation, 0n, source())).toThrow();
    }
  });
});
