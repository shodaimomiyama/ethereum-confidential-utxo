import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/cases/range-deterministic.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { buildRangeBody } from "../src/range/body.js";
import { finishRangeBody } from "../src/range/fold.js";
import { generateRangeProof } from "../src/index.js";
import { testScalarSource } from "./support/controlled-random.js";

describe("complete v3 range proof", () => {
  it("matches every word of the independent deterministic proof", () => {
    const vector = vectors[0]!;
    const body = buildRangeBody(
      { amount: BigInt(vector.input.amount), blinding: BigInt(vector.input.blinding) },
      hexBytes(vector.input.operationId), BigInt(vector.input.outputIndex),
      testScalarSource(hexBytes(vector.input.testScalarSeed)),
    );
    const proof = finishRangeBody(body);
    expect(proof.coords.map(String)).toEqual(vector.input.coords);
    expect(proof.scalars.map(String)).toEqual(vector.input.scalars);
    expect(proof.ls.map(String)).toEqual(vector.input.ls);
    expect(proof.rs.map(String)).toEqual(vector.input.rs);
    expect(body.transcript.stateHex()).toBe(vector.input.transcriptTrace.finalState);
  });

  it("accepts a valid proof whose intermediate points are identity", () => {
    const body = buildRangeBody(
      { amount: 1n, blinding: 0n }, new Uint8Array(32), 0n, { next: () => 0n },
    );
    const proof = finishRangeBody(body);
    expect(proof.coords.slice(0, 2)).toEqual([0n, 0n]);
    expect(proof.coords.slice(4, 10)).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    expect(proof.coords).toHaveLength(10);
    expect(proof.scalars).toHaveLength(5);
    expect(proof.ls).toHaveLength(12);
    expect(proof.rs).toHaveLength(12);
  });

  it("exposes a secure public entry point and rejects invalid inputs", () => {
    expect(() => generateRangeProof({ amount: 0n, blinding: 0n }, new Uint8Array(32), 0n))
      .toThrowError("INPUT:opening");
    expect(() => generateRangeProof({ amount: 1n, blinding: 0n }, new Uint8Array(31), 0n))
      .toThrowError("INPUT:rangeContext");
  });

  it("regenerates internal randomness while keeping the public context fixed", () => {
    const opening = { amount: 2n, blinding: 7n };
    const operationId = new Uint8Array(32).fill(0x44);
    const first = generateRangeProof(opening, operationId, 0n);
    const second = generateRangeProof(opening, operationId, 0n);
    expect(second.coords.slice(0, 2)).toEqual(first.coords.slice(0, 2));
    expect(second).not.toEqual(first);
  });
});
