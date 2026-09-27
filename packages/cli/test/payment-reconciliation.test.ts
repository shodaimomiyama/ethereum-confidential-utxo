import { expect, it, vi } from "vitest";
import { inspectReceipt } from "@confidential-utxo/core";
import { createCliReconciliation } from "../src/payment-reconciliation.js";

const fixture = vi.hoisted(() => {
  const hash = `0x${"11".repeat(32)}`;
  const terms = { token: "0x01", recipient: "0x02", ethAmount: 3n, minAmountOut: 4n, deadline: 5n };
  return { hash, terms, event: { transactionHash: hash, blockHash: hash,
    args: { ...terms, paymentId: hash, operationId: hash, owner: "0x03", amountOut: 4n } } };
});
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(),
  parseEventLogs: () => [fixture.event] }));
vi.mock("@confidential-utxo/core", async original => ({ ...await original<typeof import("@confidential-utxo/core")>(),
  inspectReceipt: vi.fn(async () => ({ status: "spent" })) }));
vi.mock("../src/state.js", () => ({ readOwnerState: async () => ({
  connection: { payments: { [fixture.hash]: { terms: fixture.terms } } },
  operations: { [fixture.hash]: { fixed: { outputIds: ["0x04"] } } }, receiptKeys: [],
}) }));

it("binds a later change spend to the same checkpoint when inspecting the Pay receipt", async () => {
  const { hash, event } = fixture;
  const point = { number: 10n, hash, mode: "local-simulated" };
  const observation = (value: unknown) => ({ complete: true, blockHash: hash, value });
  const consumption = observation({ executed: true, operation: { inputIds: ["0x04"] } });
  const getOperationSuccess = vi.fn(async (id: string) => id === "0x05" ? consumption : observation({ executed: true }));
  const history = {
    getFinalizedCheckpoint: async () => point,
    getOperations: async () => observation([{ success: { operationId: hash,
      transactionHash: hash, blockNumber: 2n, blockHash: hash } }]),
    getOperationSuccess,
    getUtxo: async (id: string) => observation(id === "0x04"
      ? { owner: "0x03", consumedBy: "0x05" } : { consumedBy: hash }),
    getCanonicalHeader: async () => observation({ hash }),
  };
  const input = { ownerService: { config: { dir: "/unused" }, verifiedOnline: async () => ({ history }) },
    passphrase: new Uint8Array(), context: { chainId: 31337n, deploymentBlock: 0n, finalityMode: point.mode },
    deployment: { adapter: "0x06" }, scope: { deploymentId: "local", owner: "0x03" },
    chainRpc: { getChainId: async () => 31337, getBlock: async () => ({ hash }),
      getLogs: async () => [event], getTransactionReceipt: async () => ({ status: "success", blockHash: hash,
        blockNumber: 2n, logs: [] }) } };
  const result = await createCliReconciliation(input as never).readFinalized({
    operationId: hash, paymentId: hash, scope: input.scope,
  } as never, { record: { inputId: "0x07" } } as never);
  expect(getOperationSuccess).toHaveBeenCalledWith("0x05", point);
  expect(vi.mocked(inspectReceipt).mock.calls.at(-1)?.[4].consumingOperation).toEqual(consumption);
  expect(result.receipt.status).toBe("spent");
});
