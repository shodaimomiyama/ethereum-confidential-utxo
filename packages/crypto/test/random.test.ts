import { describe, expect, it } from "vitest";
import { Q } from "../src/group.js";
import { CryptoFailure } from "../src/errors.js";
import { randomBlinding, sampleScalar } from "../src/random.js";
import { testScalarSource } from "./support/controlled-random.js";

describe("scalar sampling", () => {
  it("accepts zero only when permitted, including the 256th candidate", () => {
    const candidates = [...Array<bigint>(255).fill(Q), 0n];
    expect(sampleScalar(() => candidates.shift()!, true)).toBe(0n);
    expect(() => sampleScalar(() => 0n, false)).toThrowError("SCALAR_EXHAUSTED:scalar");
    expect(sampleScalar(() => Q - 1n, false)).toBe(Q - 1n);
  });

  it("stops after 256 rejected candidates", () => {
    let calls = 0;
    expect(() => sampleScalar(() => { calls++; return Q; }, true))
      .toThrowError("SCALAR_EXHAUSTED:scalar");
    expect(calls).toBe(256);
  });

  it("classifies random failures without exposing source errors", () => {
    const secret = "secret-marker-42";
    let error: unknown;
    try { sampleScalar(() => { throw new Error(secret); }, false); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CryptoFailure);
    expect(error).toMatchObject({ code: "RANDOM", stage: "scalar" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("provides a test-only deterministic source and a secure public entry point", () => {
    const first = testScalarSource(new Uint8Array(32).fill(7));
    const second = testScalarSource(new Uint8Array(32).fill(7));
    expect(first.next()).toBe(second.next());
    const blinding = randomBlinding();
    expect(blinding).toBeGreaterThanOrEqual(0n);
    expect(blinding).toBeLessThan(Q);
  });
});
