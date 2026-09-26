import { concat, word } from "../bytes.js";
import { CryptoFailure } from "../errors.js";
import { G, GS, H, HS } from "../fixed-parameters.js";
import {
  add, commit, dot, inverseq, M, modq, mul, multi, neg, pointBytes, powq, Q, sum,
  type Opening,
} from "../group.js";
import { sampleScalar, type ScalarSource } from "../random.js";
import { RangeTranscript } from "./transcript.js";
import type { RangeBody } from "./types.js";

export function buildRangeBody(
  opening: Opening, operationId: Uint8Array, outputIndex: bigint, source: ScalarSource,
): RangeBody {
  if (opening.amount < 1n || opening.amount > M || opening.blinding < 0n || opening.blinding >= Q) {
    throw new CryptoFailure("INPUT", "opening");
  }
  if (operationId.length !== 32 || outputIndex < 0n || outputIndex >= (1n << 256n)) {
    throw new CryptoFailure("INPUT", "rangeContext");
  }
  const next = () => sampleScalar(() => source.next(), true);
  const C_range = add(commit(opening), neg(H));
  const shiftedAmount = opening.amount - 1n;
  const bits = Array.from({ length: 64 }, (_, i) => (shiftedAmount >> BigInt(i)) & 1n);
  const shifted = bits.map((bit) => modq(bit - 1n));
  const leftMask = Array.from({ length: 64 }, next);
  const rightMask = Array.from({ length: 64 }, next);
  const alpha = next();
  const rho = next();
  const A = sum(multi(GS, bits), multi(HS, shifted), mul(G, alpha));
  const S = sum(multi(GS, leftMask), multi(HS, rightMask), mul(G, rho));
  const transcript = new RangeTranscript(operationId, outputIndex, C_range);
  const y = transcript.challenge("y", concat(pointBytes(A), pointBytes(S)));
  const z = transcript.challenge("z", new Uint8Array());
  const z2 = modq(z * z);
  const yPow = Array.from({ length: 64 }, (_, i) => powq(y, BigInt(i)));
  const leftConstant = bits.map((bit) => modq(bit - z));
  const rightConstant = bits.map((bit, i) =>
    modq(yPow[i]! * (bit - 1n + z) + z2 * (1n << BigInt(i))),
  );
  const rightLinear = rightMask.map((scalar, i) => modq(yPow[i]! * scalar));
  const t1 = modq(dot(leftMask, rightConstant) + dot(leftConstant, rightLinear));
  const t2 = dot(leftMask, rightLinear);
  const tau1 = next();
  const tau2 = next();
  const T1 = sum(mul(H, t1), mul(G, tau1));
  const T2 = sum(mul(H, t2), mul(G, tau2));
  const x = transcript.challenge("x", concat(pointBytes(T1), pointBytes(T2)));
  const le = leftConstant.map((scalar, i) => modq(scalar + leftMask[i]! * x));
  const re = rightConstant.map((scalar, i) => modq(scalar + rightLinear[i]! * x));
  const hAdjusted = HS.map((point, i) => mul(point, inverseq(yPow[i]!)));
  const t = dot(le, re);
  const tauX = modq(z2 * opening.blinding + tau1 * x + tau2 * x * x);
  const mu = modq(alpha + rho * x);
  const uChallenge = transcript.challenge("u", concat(word(tauX), word(mu), word(t)));
  const uPoint = mul(H, uChallenge);
  const innerPoint = sum(multi(GS, le), multi(hAdjusted, re), mul(uPoint, t));
  transcript.bindInner(innerPoint, uPoint);
  return { C_range, A, S, T1, T2, tauX, mu, t, le, re, g: [...GS], hAdjusted, uPoint, innerPoint, transcript };
}
