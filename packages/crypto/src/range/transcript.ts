import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToBigInt, concat, tag, word } from "../bytes.js";
import { CryptoFailure } from "../errors.js";
import { PARAMETERS_HASH_V3 } from "../fixed-parameters.js";
import { pointBytes, Q, type G1Point } from "../group.js";

export type ChallengeStage = "y" | "z" | "x" | "u" | "round";

export function acceptChallengeCandidate(candidate: bigint): boolean {
  return candidate > 0n && candidate < Q;
}

export function firstAcceptedCandidate(
  next: (counter: number) => bigint, stage = "challenge",
): { value: bigint; counter: number } {
  for (let counter = 0; counter < 256; counter++) {
    const value = next(counter);
    if (acceptChallengeCandidate(value)) return { value, counter };
  }
  throw new CryptoFailure("CHALLENGE_EXHAUSTED", stage);
}

const stageTags: Record<ChallengeStage, Uint8Array> = {
  y: tag("ecu/bp/y/v3"),
  z: tag("ecu/bp/z/v3"),
  x: tag("ecu/bp/x/v3"),
  u: tag("ecu/bp/u/v3"),
  round: tag("ecu/bp/round/v3"),
};
const candidateTag = tag("ecu/bp/challenge/v3");
const acceptedTag = tag("ecu/bp/accepted/v3");

export class RangeTranscript {
  private prefix: Uint8Array;
  lastCounter: number | null = null;

  constructor(operationId: Uint8Array, outputIndex: bigint, cRange: G1Point) {
    if (operationId.length !== 32) throw new CryptoFailure("INPUT", "operationId");
    this.prefix = concat(
      tag("ecu/bp/range/BN254/v3"), word(64n), word(1n), PARAMETERS_HASH_V3,
      operationId, tag("ecu/bp/range-output/v3"), word(outputIndex), pointBytes(cRange),
    );
  }

  stateHex(): string {
    return `0x${Buffer.from(keccak_256(this.prefix)).toString("hex")}`;
  }

  challenge(stage: ChallengeStage, payload: Uint8Array): bigint {
    const segment = concat(stageTags[stage], word(BigInt(payload.length)), payload);
    const { value, counter } = firstAcceptedCandidate(
      (index) => bytesToBigInt(keccak_256(concat(this.prefix, segment, candidateTag, word(BigInt(index))))),
      stage,
    );
    this.prefix = concat(this.prefix, segment, acceptedTag, word(value));
    this.lastCounter = counter;
    return value;
  }

  bindInner(p: G1Point, uPoint: G1Point): void {
    const payload = concat(word(64n), pointBytes(p), pointBytes(uPoint));
    this.prefix = concat(this.prefix, tag("ecu/bp/inner/v3"), word(BigInt(payload.length)), payload);
  }
}
