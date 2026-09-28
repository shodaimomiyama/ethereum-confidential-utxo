import type { Address } from "viem";
import { readOwnerState, updateOwnerState } from "./state.js";
import type { PaymentProgressV1 } from "./state.js";

export type { PaymentProgressV1, PaymentEntryV1, RewardProgressV1 } from "./state.js";

export async function readPaymentProgress(dir: string, passphrase: Uint8Array,
  owner: Address): Promise<PaymentProgressV1> {
  const state = await readOwnerState(dir, passphrase, undefined, owner);
  if (!state.connection) throw new Error("PAYMENT_PROGRESS_MISSING");
  return state.connection;
}

export async function savePaymentProgress(dir: string, passphrase: Uint8Array,
  owner: Address, expected: { revision: number }, next: PaymentProgressV1): Promise<void> {
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 ||
    next.revision !== expected.revision + 1) throw new Error("PAYMENT_PROGRESS_CONFLICT");
  await updateOwnerState(dir, passphrase, current => {
    const prior = current.connection;
    if ((prior?.revision ?? 0) !== expected.revision ||
      (prior && prior.deploymentId !== next.deploymentId) ||
      (prior && prior.recordKey !== next.recordKey)) throw new Error("PAYMENT_PROGRESS_CONFLICT");
    return { ...current, connection: next };
  }, owner);
}
