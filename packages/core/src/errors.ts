export type CoreFailureCode =
  | "INVALID_INPUT"
  | "INSUFFICIENT"
  | "UNCONSTRUCTABLE"
  | "UNCONFIRMED"
  | "HISTORY_UNAVAILABLE"
  | "INCONSISTENT"
  | "SIGNATURE_REJECTED"
  | "SIGNATURE_INVALID"
  | "RPC"
  | "UNSUPPORTED"
  | "CRYPTO"
  | "STORAGE_UNKNOWN"
  | "CONFLICT";

export class CoreFailure extends Error {
  constructor(readonly code: CoreFailureCode, readonly stage: string) {
    super(`${code}:${stage}`);
  }
}
