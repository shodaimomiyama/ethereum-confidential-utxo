export type CoreFailureCode =
  | "INVALID_INPUT"
  | "INSUFFICIENT"
  | "UNCONSTRUCTABLE"
  | "UNCONFIRMED"
  | "HISTORY_UNAVAILABLE"
  | "INCONSISTENT"
  | "SIGNATURE_REJECTED"
  | "CRYPTO"
  | "STORAGE_UNKNOWN"
  | "CONFLICT";

export class CoreFailure extends Error {
  constructor(readonly code: CoreFailureCode, readonly stage: string) {
    super(`${code}:${stage}`);
  }
}
