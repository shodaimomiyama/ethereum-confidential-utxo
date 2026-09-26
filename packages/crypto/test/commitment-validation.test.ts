import { expect, it } from "vitest";
import { P, validateCommitment } from "../src/index.js";

it("validates canonical commitments through the public API", () => {
  expect(() => validateCommitment({ x: 1n, y: 2n })).not.toThrow();
  expect(() => validateCommitment({ x: 0n, y: 0n })).not.toThrow();
  for (const point of [{ x: 1n, y: 1n }, { x: P, y: 2n }, { x: -1n, y: 2n }, { x: 1n, y: P }]) {
    expect(() => validateCommitment(point)).toThrow();
  }
});
