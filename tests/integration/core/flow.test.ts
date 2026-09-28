import { readFile, rename } from "node:fs/promises";
import { expect, it } from "vitest";
import { createWalletClient, decodeEventLog, decodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { poolAbi } from "@confidential-utxo/ethereum";
import type { Hex } from "viem";
import { withCoreAnvil } from "./anvil.js";
import { createCli } from "./cli.js";
import { executeCliOperation, prepareRecipients } from "./operations.js";

async function availableIds(cli: ReturnType<typeof createCli>, args: string[]): Promise<Hex[]> {
  const result = await cli.runOwnerCli(["utxos", ...args]);
  expect(result.status).toBe("complete");
  return (result.entries as { id: Hex; status: string }[])
    .filter(entry => entry.status === "available").map(entry => entry.id);
}

it("S-01-deposit S-03-partial-transfer S-03-independent-spend S-07-offline-recipient S-14-separate-submitter S-16-calldata S-16-events S-16-cli-json", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    const submitterBalance = await fixture.client.getBalance({ address: fixture.submitter.address });
    const deposit = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "10",
      extra: ["--recipient", recipients.alice] });
    fixture.recordOperation(["S-01-deposit"], deposit.operationId, deposit.txHash);
    expect((await fixture.client.getTransactionReceipt({ hash: deposit.txHash })).status).toBe("success");
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(10n);
    const sent = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "3",
      extra: ["--recipient", recipients.bob, "--change-recipient", recipients.alice] });
    fixture.recordOperation(["S-03-partial-transfer", "S-07-offline-recipient", "S-16-calldata",
      "S-16-events", "S-16-cli-json"], sent.operationId, sent.txHash);
    expect(sent.operationId).toMatch(/^0x[0-9a-f]{64}$/i);
    const publicTx = await fixture.client.getTransaction({ hash: sent.txHash });
    const decoded = decodeFunctionData({ abi: poolAbi, data: publicTx.input });
    if (decoded.functionName !== "transfer") throw new Error("expected public transfer calldata");
    const request = decoded.args[0];
    expect(Object.keys(request).sort()).toEqual([
      "d", "destination", "inputIds", "kind", "outputs", "owner", "salt", "w",
    ]);
    expect(request.outputs).toHaveLength(2);
    for (const output of request.outputs) {
      expect(Object.keys(output).sort()).toEqual(["Cx", "Cy", "owner", "packet", "receiptFormat"]);
      expect(output.packet).toMatch(/^0x[0-9a-f]{224}$/i);
    }
    const transferReceipt = await fixture.client.getTransactionReceipt({ hash: sent.txHash });
    const succeeded = transferReceipt.logs.flatMap(log => {
      try {
        const event = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics });
        return event.eventName === "OperationSucceeded" ? [event.args] : [];
      } catch { return []; }
    });
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.operationId).toBe(sent.operationId);
    expect(succeeded[0]?.kind).toBe(1);
    expect(succeeded[0]?.d).toBe(0n);
    expect(succeeded[0]?.w).toBe(0n);
    const created = transferReceipt.logs.flatMap(log => {
      try {
        const event = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics });
        return event.eventName === "OutputCreated" ? [event.args] : [];
      } catch { return []; }
    });
    expect(created).toHaveLength(2);
    for (const event of created) {
      expect(Object.keys(event).sort()).toEqual(["Cx", "Cy", "operationId", "outputIndex", "owner",
        "packet", "receiptFormat", "utxoId"]);
      expect(request.outputs.some(output => output.packet === event.packet)).toBe(true);
    }
    const exported = JSON.parse(await readFile(`${fixture.root}/${sent.operationId}.json`, "utf8")) as Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual(["balanceProof", "chainId", "operationId", "pool",
      "rangeProofs", "request", "schemaVersion", "signature"]);
    expect(JSON.stringify(exported)).not.toMatch(/opening|blinding|passphrase|recipientPrivateKey|rpcUrl/i);
    const balanceDto = await cli.runOwnerCli(["balance", ...fixture.alice.args]);
    const utxoDto = await cli.runOwnerCli(["utxos", ...fixture.alice.args]);
    expect(balanceDto).not.toHaveProperty("amount");
    expect(balanceDto).not.toHaveProperty("availableWei");
    expect(JSON.stringify(utxoDto)).not.toMatch(/amountWei|opening|blinding|passphrase/i);
    const diagnostic = await cli.runResultCli(["operation", ...fixture.alice.args,
      "--id", `0x${"ff".repeat(32)}`]);
    expect(diagnostic.code).not.toBe(0);
    expect(Object.keys(diagnostic.value).sort()).toEqual(["code", "kind", "schemaVersion"]);
    expect(JSON.stringify(diagnostic.value)).not.toMatch(/amountWei|opening|blinding|passphrase|rpcUrl/i);
    for (const raw of [await cli.runRaw(["balance", ...fixture.alice.args]),
      await cli.runRaw(["operation", ...fixture.alice.args, "--id", `0x${"ff".repeat(32)}`])]) {
      expect(raw.output).not.toMatch(/amountWei|opening|blinding|passphrase=|recipientPrivateKey|rpcUrl|secret/i);
    }
    await rename(fixture.alice.store, `${fixture.alice.store}.inaccessible`);
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(3n);
    const independent = await executeCliOperation(fixture, { ownerArgs: fixture.bob.args,
      signer: fixture.bob.signer, kind: "transfer", amountWei: "1",
      extra: ["--recipient", recipients.bob, "--change-recipient", recipients.bob] });
    fixture.recordOperation(["S-03-independent-spend", "S-14-separate-submitter"],
      independent.operationId, independent.txHash);
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(3n);
    const bobEthBefore = await fixture.client.getBalance({ address: fixture.bob.address });
    await executeCliOperation(fixture, { ownerArgs: fixture.bob.args,
      signer: fixture.bob.signer, kind: "withdraw", amountWei: "2",
      extra: ["--destination", fixture.bob.address] });
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(1n);
    expect(await fixture.client.getBalance({ address: fixture.bob.address })).toBe(bobEthBefore + 2n);
    expect(await fixture.client.getBalance({ address: fixture.submitter.address })).toBeLessThan(submitterBalance - 13n);
  });
}, 180_000);

it("S-02-full-transfer S-04-two-input-merge S-05-self-merge S-05-self-split S-05-recreate S-17-fresh-salt-deposit", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    const deposit = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "10", extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const full = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "10", extra: ["--recipient", recipients.bob] });
    fixture.recordOperation(["S-02-full-transfer"], full.operationId, full.txHash);
    expect(full.operationId).not.toBe(deposit.operationId);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(0n);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(10n);
    await executeCliOperation(fixture, { ownerArgs: fixture.bob.args,
      signer: fixture.bob.signer, kind: "transfer", amountWei: "3",
      extra: ["--recipient", recipients.alice, "--change-recipient", recipients.bob] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const firstInput = (await availableIds(cli, fixture.alice.args))[0]!;
    await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "2", extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const inputs = await availableIds(cli, fixture.alice.args);
    expect(inputs).toHaveLength(2);
    const secondInput = inputs.find(id => id !== firstInput)!;
    const merged = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "5",
      extra: ["--recipient", recipients.alice, "--input-id", firstInput, "--input-id", secondInput] });
    fixture.recordOperation(["S-04-two-input-merge", "S-05-self-merge"], merged.operationId, merged.txHash);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    expect(await availableIds(cli, fixture.alice.args)).toHaveLength(1);
    for (const id of inputs) {
      const onchain = await fixture.client.readContract({ address: fixture.manifest.pool.address,
        abi: poolAbi, functionName: "getUtxo", args: [id] });
      expect(onchain[0]).toBe(2);
    }
    const mergedId = (await availableIds(cli, fixture.alice.args))[0]!;
    const splitResult = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "2",
      extra: ["--recipient", recipients.alice, "--change-recipient", recipients.alice, "--input-id", mergedId] });
    fixture.recordOperation(["S-05-self-split"], splitResult.operationId, splitResult.txHash);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const split = await availableIds(cli, fixture.alice.args);
    expect(split).toHaveLength(2);
    const recreated = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "5",
      extra: ["--recipient", recipients.alice, ...split.flatMap(id => ["--input-id", id])] });
    fixture.recordOperation(["S-05-recreate"], recreated.operationId, recreated.txHash);
    expect(recreated.operationId).not.toBe(full.operationId);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    expect(await availableIds(cli, fixture.alice.args)).toHaveLength(1);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(5n);
    const freshOne = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "1", extra: ["--recipient", recipients.alice] });
    const freshTwo = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "deposit", amountWei: "1", extra: ["--recipient", recipients.alice] });
    fixture.recordOperation(["S-17-fresh-salt-deposit"], freshOne.operationId, freshOne.txHash);
    fixture.recordOperation(["S-17-fresh-salt-deposit"], freshTwo.operationId, freshTwo.txHash);
    expect(freshOne.operationId).not.toBe(freshTwo.operationId);
  });
}, 300_000);

it("S-06-self-full-withdraw S-06-self-partial-withdraw S-06-third-party-full-withdraw S-06-third-party-partial-withdraw S-06-contract-full-withdraw S-06-contract-partial-withdraw", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    const key = (await readFile(fixture.submitter.signer, "utf8")).trim() as Hex;
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: http(fixture.rpcUrl) });
    const deployment = await wallet.sendTransaction({ data: "0x6001600c60003960016000f300" });
    const contract = (await fixture.client.waitForTransactionReceipt({ hash: deployment })).contractAddress;
    expect(contract).not.toBeNull();
    expect(await fixture.client.getCode({ address: contract! })).toBe("0x00");
    for (const destination of [fixture.alice.address, fixture.bob.address, contract!]) {
      for (const amount of [4n, 1n]) {
        const oldIds = new Set(await availableIds(cli, fixture.alice.args));
        await executeCliOperation(fixture, { ownerArgs: fixture.alice.args, signer: fixture.alice.signer,
          kind: "deposit", amountWei: "4", extra: ["--recipient", recipients.alice] });
        await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
        const fresh = (await availableIds(cli, fixture.alice.args)).filter(id => !oldIds.has(id));
        expect(fresh).toHaveLength(1);
        const balanceBefore = await fixture.client.getBalance({ address: destination });
        const accountingBefore = await fixture.client.readContract({ address: fixture.manifest.pool.address,
          abi: poolAbi, functionName: "getAccounting" });
        const withdrawn = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args, signer: fixture.alice.signer,
          kind: "withdraw", amountWei: amount.toString(), extra: ["--destination", destination,
            "--input-id", fresh[0]!, ...(amount < 4n ? ["--change-recipient", recipients.alice] : [])] });
        const destinationCase = destination === fixture.alice.address ? "self" :
          destination === fixture.bob.address ? "third-party" : "contract";
        const amountCase = amount === 4n ? "full" : "partial";
        fixture.recordOperation([`S-06-${destinationCase}-${amountCase}-withdraw`],
          withdrawn.operationId, withdrawn.txHash);
        expect(await fixture.client.getBalance({ address: destination })).toBe(balanceBefore + amount);
        const accountingAfter = await fixture.client.readContract({ address: fixture.manifest.pool.address,
          abi: poolAbi, functionName: "getAccounting" });
        expect(accountingAfter[1]).toBe(accountingBefore[1] - amount);
        const spent = await fixture.client.readContract({ address: fixture.manifest.pool.address,
          abi: poolAbi, functionName: "getUtxo", args: [fresh[0]!] });
        expect(spent[0]).toBe(2);
        await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
      }
    }
  });
}, 400_000);
