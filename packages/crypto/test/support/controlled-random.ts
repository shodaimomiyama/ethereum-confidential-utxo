import { createHash } from "node:crypto";
import { bytesToBigInt, concat, word } from "../../src/bytes.js";

export function testScalarSource(seed: Uint8Array): { next(): bigint } {
  if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  let counter = 0n;
  return {
    next(): bigint {
      const candidate = bytesToBigInt(createHash("sha256").update(concat(seed, word(counter++))).digest());
      return candidate;
    },
  };
}
