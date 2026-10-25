import { expect, it } from "vitest";
import { poolAbi } from "@confidential-utxo/ethereum";
import { withCoreAnvil } from "./anvil.js";
import { prepareRejectionFixture } from "./operations.js";

it("S-11-outer-revert rolls back inner acceptance", async () => {
  await withCoreAnvil(async fixture => {
    const prepared = await prepareRejectionFixture(fixture);
    const transfer = await prepared.transfer(5n);
    const pool = prepared.context.pool;
    await fixture.client.call({ account: fixture.submitter.address, to: pool,
      data: transfer.calldata.data, value: 0n, gas: 15_000_000n });
    const accounting = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getAccounting" });
    const input = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getUtxo", args: [prepared.available[0]!.id] });
    const base = `36600060003760006000366000600073${pool.slice(2)}5af1`;
    const failedCallJump = (base.length / 2 + 9).toString(16).padStart(2, "0");
    const runtime = `${base}1560${failedCallJump}5760006000fd5b00`;
    const length = (runtime.length / 2).toString(16).padStart(2, "0");
    const initcode = `0x60${length}600c60003960${length}6000f3${runtime}` as const;
    const relayHash = await prepared.wallet.sendTransaction({ data: initcode, gas: 500_000n });
    const relay = (await fixture.client.waitForTransactionReceipt({ hash: relayHash })).contractAddress;
    expect(relay).not.toBeNull();
    const hash = await prepared.wallet.sendTransaction({ to: relay!, data: transfer.calldata.data,
      value: 0n, gas: 15_000_000n });
    const receipt = await fixture.client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");
    expect(receipt.logs).toHaveLength(0);
    expect(await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "isOperationExecuted", args: [transfer.operationId] })).toBe(false);
    expect(await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getUtxo", args: [prepared.available[0]!.id] })).toEqual(input);
    const rolledBackOutput = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getUtxo", args: [transfer.outputIds[0]!] });
    expect(rolledBackOutput[0]).toBe(0);
    expect(await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getAccounting" })).toEqual(accounting);
  });
}, 180_000);
