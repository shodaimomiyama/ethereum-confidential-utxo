export type EthereumFailureCode =
  | "INVALID_CONFIG" | "DEPLOYMENT_MISMATCH" | "UNSUPPORTED"
  | "RPC" | "GAP" | "HASH_MISMATCH" | "TIMEOUT" | "ABORTED"
  | "SIGNATURE_REJECTED" | "SIGNATURE_INVALID" | "SIMULATION_FAILED"
  | "SUBMISSION_UNKNOWN" | "OUTER_REVERT" | "UNKNOWN_REVERT";

/** Contains only a public code and stage, never a provider error or credential. */
export class EthereumFailure extends Error {
  constructor(readonly code: EthereumFailureCode, readonly stage: string) {
    super(`${code}:${stage}`);
    this.name = "EthereumFailure";
  }
}
