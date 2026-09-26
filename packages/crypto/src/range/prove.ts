import { CryptoFailure } from "../errors.js";
import type { Opening } from "../group.js";
import { makeSecureScalarSource } from "../random.js";
import { buildRangeBody } from "./body.js";
import { finishRangeBody, type RangeProof } from "./fold.js";

export function generateRangeProof(
  opening: Opening, operationId: Uint8Array, outputIndex: bigint,
): RangeProof {
  try {
    return finishRangeBody(buildRangeBody(opening, operationId, outputIndex, makeSecureScalarSource()));
  } catch (error) {
    if (error instanceof CryptoFailure) throw error;
    throw new CryptoFailure("INTERNAL", "rangeProof");
  }
}
