import { bn254 } from "@noble/curves/bn254.js";
import { concat, word } from "./bytes.js";
import { G, H } from "./fixed-parameters.js";

export const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const M = 1n << 64n;
export type G1Point = Readonly<{ x: bigint; y: bigint }>;
export type Opening = Readonly<{ amount: bigint; blinding: bigint }>;

const zero = bn254.G1.Point.ZERO;

export function parsePoint(point: G1Point, allowIdentity: boolean): G1Point {
  if (point.x === 0n && point.y === 0n) {
    if (!allowIdentity) throw new RangeError("identity point");
    return point;
  }
  if (point.x < 0n || point.y < 0n || point.x >= P || point.y >= P) {
    throw new RangeError("noncanonical point");
  }
  bn254.G1.Point.fromAffine(point).assertValidity();
  return point;
}

function nativePoint(point: G1Point) {
  parsePoint(point, true);
  return point.x === 0n && point.y === 0n ? zero : bn254.G1.Point.fromAffine(point);
}

function publicPoint(point: ReturnType<typeof nativePoint>): G1Point {
  return point.equals(zero) ? { x: 0n, y: 0n } : point.toAffine();
}

export function mul(point: G1Point, scalar: bigint): G1Point {
  if (scalar < 0n || scalar >= Q) throw new RangeError("scalar out of range");
  return scalar === 0n ? { x: 0n, y: 0n } : publicPoint(nativePoint(point).multiply(scalar));
}

export function add(left: G1Point, right: G1Point): G1Point {
  return publicPoint(nativePoint(left).add(nativePoint(right)));
}

export function neg(point: G1Point): G1Point {
  return publicPoint(nativePoint(point).negate());
}

export function sum(...points: readonly G1Point[]): G1Point {
  return points.reduce((acc, point) => add(acc, point), { x: 0n, y: 0n });
}

export function samePoint(left: G1Point, right: G1Point): boolean {
  return left.x === right.x && left.y === right.y;
}

export function pointPair(point: G1Point): bigint[] {
  return [point.x, point.y];
}

export function pointBytes(point: G1Point): Uint8Array {
  parsePoint(point, true);
  return concat(word(point.x), word(point.y));
}

export function modq(value: bigint): bigint {
  const residue = value % Q;
  return residue < 0n ? residue + Q : residue;
}

export function powq(base: bigint, exponent: bigint): bigint {
  if (exponent < 0n) throw new RangeError("negative exponent");
  let result = 1n;
  let factor = modq(base);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = modq(result * factor);
    factor = modq(factor * factor);
    power >>= 1n;
  }
  return result;
}

export function inverseq(value: bigint): bigint {
  if (modq(value) === 0n) throw new RangeError("zero has no inverse");
  return powq(value, Q - 2n);
}

export function dot(left: readonly bigint[], right: readonly bigint[]): bigint {
  if (left.length !== right.length) throw new RangeError("vector dimension mismatch");
  return modq(left.reduce((total, value, index) => total + value * right[index]!, 0n));
}

export function multi(points: readonly G1Point[], scalars: readonly bigint[]): G1Point {
  if (points.length !== scalars.length) throw new RangeError("vector dimension mismatch");
  return sum(...points.map((point, index) => mul(point, modq(scalars[index]!))));
}

export function commit(opening: Opening): G1Point {
  if (opening.amount < 1n || opening.amount > M) throw new RangeError("amount out of range");
  if (opening.blinding < 0n || opening.blinding >= Q) throw new RangeError("blinding out of range");
  return add(mul(H, opening.amount), mul(G, opening.blinding));
}
