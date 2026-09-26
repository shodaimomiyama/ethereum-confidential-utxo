import { concat, word } from "../bytes.js";
import {
  dot, inverseq, modq, mul, multi, pointBytes, pointPair, sum, type G1Point,
} from "../group.js";
import type { RangeBody } from "./types.js";

export type RangeProof = Readonly<{
  coords: readonly bigint[];
  scalars: readonly bigint[];
  ls: readonly bigint[];
  rs: readonly bigint[];
}>;

function columns(points: readonly G1Point[]): bigint[] {
  return [...points.map((point) => point.x), ...points.map((point) => point.y)];
}

export function finishRangeBody(body: RangeBody): RangeProof {
  let le = body.le;
  let re = body.re;
  let g = body.g;
  let h = body.hAdjusted;
  const leftPoints: G1Point[] = [];
  const rightPoints: G1Point[] = [];
  for (let round = 0; round < 6; round++) {
    const half = le.length / 2;
    const ll = le.slice(0, half);
    const lh = le.slice(half);
    const rl = re.slice(0, half);
    const rh = re.slice(half);
    const left = sum(
      multi(g.slice(half), ll), multi(h.slice(0, half), rh), mul(body.uPoint, dot(ll, rh)),
    );
    const right = sum(
      multi(g.slice(0, half), lh), multi(h.slice(half), rl), mul(body.uPoint, dot(lh, rl)),
    );
    leftPoints.push(left);
    rightPoints.push(right);
    const challenge = body.transcript.challenge(
      "round", concat(word(BigInt(round)), pointBytes(left), pointBytes(right)),
    );
    const inverse = inverseq(challenge);
    g = g.slice(0, half).map((point, i) =>
      sum(mul(point, inverse), mul(g[i + half]!, challenge)),
    );
    h = h.slice(0, half).map((point, i) =>
      sum(mul(point, challenge), mul(h[i + half]!, inverse)),
    );
    le = ll.map((value, i) => modq(value * challenge + lh[i]! * inverse));
    re = rl.map((value, i) => modq(value * inverse + rh[i]! * challenge));
  }
  const coords = [body.C_range, body.A, body.S, body.T1, body.T2].flatMap(pointPair);
  const scalars = [body.tauX, body.mu, body.t, le[0]!, re[0]!];
  const ls = columns(leftPoints);
  const rs = columns(rightPoints);
  if (coords.length !== 10 || scalars.length !== 5 || ls.length !== 12 || rs.length !== 12) {
    throw new Error("range proof shape mismatch");
  }
  return { coords, scalars, ls, rs };
}
