import { expect, it } from "vitest";
import { inspectReceipt, synchronize } from "@confidential-utxo/core";
import { createHistoryPort, defaultRpcPolicy, poolAbi, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import { withCoreAnvil } from "./anvil.js";
import { createCli } from "./cli.js";
import { executeCliOperation, prepareRecipients, submitMalformedTransfer } from "./operations.js";

it("S-08-decrypt-failure S-08-commitment-mismatch S-08-history-replay S-08-missing-output-log S-08-unconfirmed", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "12",
      extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const before = await fixture.client.readContract({ address: fixture.manifest.pool.address,
      abi: poolAbi, functionName: "getAccounting" });
    const wrongKey = await submitMalformedTransfer(fixture, recipients.bob, recipients.alice, "wrong-key", 5n);
    expect((await fixture.client.getTransactionReceipt({ hash: wrongKey.txHash })).status).toBe("success");
    const first = await fixture.client.readContract({ address: fixture.manifest.pool.address,
      abi: poolAbi, functionName: "getUtxo", args: [wrongKey.outputId] });
    expect(first[0]).toBe(1);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const mismatch = await submitMalformedTransfer(fixture, recipients.bob, recipients.alice,
      "commitment-mismatch", 7n);
    expect((await fixture.client.getTransactionReceipt({ hash: mismatch.txHash })).status).toBe("success");
    const second = await fixture.client.readContract({ address: fixture.manifest.pool.address,
      abi: poolAbi, functionName: "getUtxo", args: [mismatch.outputId] });
    expect(second[0]).toBe(1);
    const after = await fixture.client.readContract({ address: fixture.manifest.pool.address,
      abi: poolAbi, functionName: "getAccounting" });
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    const sync = await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(sync.status).toBe("complete");
    expect((sync.receiptFailures as { outputId: string; reason: string }[]).map(item => item.reason))
      .toEqual(["DECRYPT", "DECRYPT"]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(0n);
    const replay = await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(replay.receiptFailures).toEqual(sync.receiptFailures);
    const verified = await verifyEthereumDeployment(fixture.client, fixture.manifest, "local-simulated");
    const history = createHistoryPort(verified, fixture.client, defaultRpcPolicy);
    const point = await history.getFinalizedCheckpoint();
    if (!point) throw new Error("Anvil finality checkpoint missing");
    const operations = await history.getOperations(verified.context.deploymentBlock, point);
    if (!operations.complete) throw new Error("Anvil history incomplete");
    const observed = operations.value.find(item => item.success?.operationId === wrongKey.operationId);
    if (!observed?.success) throw new Error("accepted operation missing from history");
    const missingOutput = { ...structuredClone(observed), outputLogs: [] };
    const state = {
      context: verified.context,
      creationBlock: await history.getCanonicalHeader(observed.success.blockNumber, point),
      operation: await history.getOperationSuccess(wrongKey.operationId, point),
      utxo: await history.getUtxo(wrongKey.outputId, point),
    };
    expect(await inspectReceipt(missingOutput, 0, fixture.bob.address,
      { getKey: async () => { throw new Error("key should not be read"); } }, state, point))
      .toEqual({ status: "unknown", reason: "MISSING_OUTPUT" });
    const incomplete = await synchronize(verified.context, { history: {
      ...history,
      getOperations: async (from, at) => {
        const result = await history.getOperations(from, at);
        if (!result.complete) return result;
        return { ...result, value: result.value.map(item => item.success?.operationId === wrongKey.operationId
          ? { ...item, outputLogs: [] } : item) };
      },
    }, keys: { getKey: async () => new Uint8Array(32) }, owners: [fixture.bob.address] });
    expect(incomplete).toMatchObject({ status: "unconfirmed", reason: "INCOMPLETE_HISTORY" });
    const noFinality = await synchronize(verified.context, { history: {
      ...history, getFinalizedCheckpoint: async () => null,
    }, keys: { getKey: async () => new Uint8Array(32) }, owners: [fixture.bob.address] });
    expect(noFinality).toMatchObject({ status: "unconfirmed", reason: "NO_FINALITY" });
    expect(await fixture.client.readContract({ address: fixture.manifest.pool.address,
      abi: poolAbi, functionName: "getAccounting" })).toEqual(after);
  });
}, 180_000);
