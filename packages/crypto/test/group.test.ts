import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commit, parsePoint, pointBytes, P, Q, M } from "../src/group.js";
import { G, GS, H, HS, PARAMETERS_HASH_V3 } from "../src/fixed-parameters.js";

type Vector = {
  id: string;
  input?: { amount?: string; blinding?: string };
  expected: { point?: string[]; parametersHash?: string; generatorCount?: number };
};
const vectors = JSON.parse(
  readFileSync(new URL("../../../tests/vectors/cases/group.json", import.meta.url), "utf8"),
) as Vector[];

function byId(id: string): Vector {
  const vector = vectors.find((item) => item.id === id);
  if (!vector) throw new Error(`missing vector ${id}`);
  return vector;
}

describe("fixed BN254 profile", () => {
  it.each([
    "VEC-03-COMMITMENT-AMOUNT-1-BLINDING-42",
    "VEC-03-COMMITMENT-AMOUNT-MAX-BLINDING-42",
    "VEC-03-COMMITMENT-AMOUNT-1-BLINDING-0",
  ])("matches independent commitment %s", (id) => {
    const vector = byId(id);
    const actual = commit({
      amount: BigInt(vector.input!.amount!),
      blinding: BigInt(vector.input!.blinding!),
    });
    expect([String(actual.x), String(actual.y)]).toEqual(vector.expected.point);
  });

  it("preserves the inclusive upper amount and rejects out-of-range openings", () => {
    expect(commit({ amount: M, blinding: 42n })).toBeDefined();
    expect(() => commit({ amount: 0n, blinding: 0n })).toThrow();
    expect(() => commit({ amount: M + 1n, blinding: 0n })).toThrow();
    expect(() => commit({ amount: 1n, blinding: Q })).toThrow();
    expect(() => commit({ amount: 1n, blinding: -1n })).toThrow();
    expect(commit({ amount: 1n, blinding: Q - 1n })).toBeDefined();
  });

  it("accepts only the canonical identity and canonical curve points", () => {
    expect(parsePoint({ x: 0n, y: 0n }, true)).toEqual({ x: 0n, y: 0n });
    expect(pointBytes({ x: 0n, y: 0n })).toEqual(new Uint8Array(64));
    expect(() => parsePoint({ x: 0n, y: 0n }, false)).toThrow();
    expect(() => parsePoint({ x: P, y: 1n }, true)).toThrow();
    expect(() => parsePoint({ x: 1n, y: 1n }, true)).toThrow();
    expect(() => parsePoint({ x: -1n, y: 1n }, true)).toThrow();
  });

  it("matches the independent parameter hash for 130 distinct nonidentity generators", () => {
    const vector = byId("VEC-03-PARAMETERS-HASH");
    const points = [H, G, ...GS, ...HS];
    expect(points).toHaveLength(130);
    expect(new Set(points.map((point) => Buffer.from(pointBytes(point)).toString("hex"))).size).toBe(130);
    expect(points.every((point) => point.x !== 0n || point.y !== 0n)).toBe(true);
    expect("0x" + Buffer.from(PARAMETERS_HASH_V3).toString("hex")).toBe(vector.expected.parametersHash);
  });
});
