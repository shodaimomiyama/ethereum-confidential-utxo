import { describe, expect, it } from "vitest";
import vectors from "../../../tests/vectors/cases/range-deterministic.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { Q } from "../src/group.js";
import { acceptChallengeCandidate, firstAcceptedCandidate, RangeTranscript } from "../src/range/transcript.js";

const point = (pair: readonly string[]) => ({ x: BigInt(pair[0]!), y: BigInt(pair[1]!) });

describe("v3 range transcript", () => {
  it("matches every stored challenge and full-prefix state", () => {
    for (const vector of vectors) {
      const tr = new RangeTranscript(hexBytes(vector.input.operationId), BigInt(vector.input.outputIndex), point(vector.expected.C_range));
      expect(tr.stateHex()).toBe(vector.input.transcriptTrace.initialState);
      for (const step of vector.input.transcriptTrace.stages) {
        expect(tr.stateHex()).toBe(step.previousState);
        if (step.stage === "inner") {
          tr.bindInner(point(step.P!), point(step.uPoint!));
        } else {
          expect(tr.challenge(step.stage as "y" | "z" | "x" | "u" | "round", hexBytes(step.payloadHex)))
            .toBe(BigInt(step.challenge!));
          expect(tr.lastCounter).toBe(step.counter);
        }
        expect(tr.stateHex()).toBe(step.nextState);
      }
    }
  });

  it("rejects noncanonical candidates and bounds the search", () => {
    expect([0n, Q, (1n << 256n) - 1n].map(acceptChallengeCandidate)).toEqual([false, false, false]);
    expect([1n, Q - 1n].map(acceptChallengeCandidate)).toEqual([true, true]);
    const candidates = [...Array<bigint>(255).fill(Q), 1n];
    expect(firstAcceptedCandidate(() => candidates.shift()!)).toEqual({ value: 1n, counter: 255 });
    expect(() => firstAcceptedCandidate(() => Q)).toThrowError("CHALLENGE_EXHAUSTED:challenge");
    expect(() => firstAcceptedCandidate(() => Q, "round")).toThrowError("CHALLENGE_EXHAUSTED:round");
  });

  it("binds operation and output identities", () => {
    const vector = vectors[0]!;
    const commitment = point(vector.expected.C_range);
    const operation = hexBytes(vector.input.operationId);
    const altered = operation.slice(); altered[0]! ^= 1;
    const original = new RangeTranscript(operation, 0n, commitment);
    expect(new RangeTranscript(altered, 0n, commitment).stateHex()).not.toBe(original.stateHex());
    expect(new RangeTranscript(operation, 1n, commitment).stateHex()).not.toBe(original.stateHex());
  });
});
