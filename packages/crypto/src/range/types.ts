import type { G1Point } from "../group.js";
import type { RangeTranscript } from "./transcript.js";

export type RangeBody = {
  C_range: G1Point;
  A: G1Point;
  S: G1Point;
  T1: G1Point;
  T2: G1Point;
  tauX: bigint;
  mu: bigint;
  t: bigint;
  le: bigint[];
  re: bigint[];
  g: G1Point[];
  hAdjusted: G1Point[];
  uPoint: G1Point;
  innerPoint: G1Point;
  transcript: RangeTranscript;
};
