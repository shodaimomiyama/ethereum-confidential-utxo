import { expect, it } from "vitest";
import type { Hex } from "viem";
import {
  CoreFailure,
  type Checkpoint,
  type Context,
  type HistoryPort,
  type LocalDraft,
  type Observation,
  type ObservedOperation,
  type OperationAuthorizationTypedData,
  type OperationRequest,
  type OperationSuccess,
  type OwnedUtxo,
  type PublicOutput,
  type ReceiptKeyPort,
  type SignerPort,
  type StoragePort,
  type UtxoState,
} from "../src/index.js";

type PublicTypes = [
  Checkpoint, Context, HistoryPort, LocalDraft, Observation<unknown>,
  ObservedOperation, OperationAuthorizationTypedData, OperationRequest,
  OperationSuccess, OwnedUtxo, PublicOutput, ReceiptKeyPort, SignerPort,
  StoragePort, UtxoState,
];

it("keeps the public operation request free of secret openings", () => {
  const request: OperationRequest = {
    kind: 0,
    owner: "0x1111111111111111111111111111111111111111",
    salt: (`0x${"01".repeat(32)}`) as Hex,
    inputIds: [],
    outputs: [],
    d: 1n,
    w: 0n,
    destination: "0x0000000000000000000000000000000000000000",
  };
  const invalidRequest: OperationRequest = {
    ...request,
    // @ts-expect-error public requests cannot carry a secret opening
    opening: { amount: 1n, blinding: 2n },
  };
  expect(request).not.toHaveProperty("opening");
  expect(invalidRequest).toHaveProperty("opening");
  expect(new CoreFailure("HISTORY_UNAVAILABLE", "sync").code).toBe("HISTORY_UNAVAILABLE");
});
