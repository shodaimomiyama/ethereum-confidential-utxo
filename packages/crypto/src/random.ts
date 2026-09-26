import { bytesToBigInt } from "./bytes.js";
import { CryptoFailure } from "./errors.js";
import { Q } from "./group.js";

export type ScalarSource = { next(): bigint };

export function sampleScalar(nextCandidate: () => bigint, allowZero: boolean): bigint {
  for (let attempt = 0; attempt < 256; attempt++) {
    let candidate: bigint;
    try { candidate = nextCandidate(); }
    catch { throw new CryptoFailure("RANDOM", "scalar"); }
    if (typeof candidate === "bigint" && candidate >= (allowZero ? 0n : 1n) && candidate < Q) {
      return candidate;
    }
  }
  throw new CryptoFailure("SCALAR_EXHAUSTED", "scalar");
}

export function makeSecureScalarSource(): ScalarSource {
  return {
    next(): bigint {
      return bytesToBigInt(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    },
  };
}

export function randomBlinding(): bigint {
  const source = makeSecureScalarSource();
  return sampleScalar(() => source.next(), true);
}
