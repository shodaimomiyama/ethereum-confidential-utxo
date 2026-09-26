export type CryptoFailureCode =
  | "INPUT"
  | "RANDOM"
  | "SCALAR_EXHAUSTED"
  | "CHALLENGE_EXHAUSTED"
  | "DECRYPT"
  | "PLAINTEXT"
  | "COMMITMENT"
  | "INTERNAL";

export class CryptoFailure extends Error {
  constructor(public readonly code: CryptoFailureCode, public readonly stage: string) {
    super(`${code}:${stage}`);
    this.name = "CryptoFailure";
  }
}
