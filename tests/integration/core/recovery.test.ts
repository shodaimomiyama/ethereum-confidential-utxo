import { expect, it } from "vitest";
import { withCoreAnvil } from "./anvil.js";
import { createCli } from "./cli.js";
import { executeCliOperation, prepareRecipients } from "./operations.js";
import { startRpcFaultProxy } from "./rpc-fault.js";
import { readOwnerState } from "../../../packages/cli/src/state.js";

async function anvilRequest<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await response.json() as { result?: T; error?: { code: number } };
  if (json.error || json.result === undefined) throw new Error(`Anvil method ${method} failed`);
  return json.result;
}

it("S-15-rpc-failure S-15-duplicate-history S-15-missing-history", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    await executeCliOperation(fixture, { ownerArgs: fixture.alice.args, signer: fixture.alice.signer,
      kind: "deposit", amountWei: "10", extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const before = await cli.runOwnerCli(["utxos", ...fixture.alice.args]);
    const beforeIds = (before.entries as { id: string; status: string }[])
      .filter(item => item.status === "available").map(item => item.id);
    expect(beforeIds).toHaveLength(1);
    const proxy = await startRpcFaultProxy(fixture.rpcUrl);
    try {
      expect(proxy.rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const online = ["--manifest", fixture.manifestFile, "--rpc", proxy.rpcUrl];
      proxy.injectRpcFault({ method: "eth_getLogs", nth: 2, action: "duplicate" });
      expect((await cli.runResultCli(["sync", ...fixture.alice.args, ...online])).value.status)
        .toBe("complete");
      expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(10n);
      proxy.injectRpcFault({ method: "eth_getLogs", nth: 2, action: "drop" });
      const missing = await cli.runResultCli(["sync", ...fixture.alice.args, ...online]);
      expect(missing.value.status).toBe("unconfirmed");
      const stale = await cli.runResultCli(["utxos", ...fixture.alice.args]);
      expect(stale.value.status).toBe("stale");
      expect(stale.value.entries).toEqual([]);
      const state = await readOwnerState(fixture.alice.store, Buffer.from("secret"));
      expect(state.sync?.status).toBe("unconfirmed");
      if (state.sync?.status !== "unconfirmed") throw new Error("missing stale checkpoint");
      expect(state.sync.previous?.utxos.map(item => item.id)).toEqual(beforeIds);
      expect(state.sync.previous?.utxos.every(item => item.status === "unknown")).toBe(true);
      proxy.injectRpcFault({ method: "eth_getLogs", nth: 2, action: "error" });
      const failed = await cli.runResultCli(["sync", ...fixture.alice.args, ...online]);
      expect(failed.value.status).toBe("unconfirmed");
      proxy.clear();
      expect((await cli.runResultCli(["sync", ...fixture.alice.args, ...online])).value.status)
        .toBe("complete");
      expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(10n);
    }
    finally { await proxy.close(); }
  });
}, 180_000);

it("S-15-pending S-15-lost-ack S-15-backup-restore", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    await executeCliOperation(fixture, { ownerArgs: fixture.alice.args, signer: fixture.alice.signer,
      kind: "deposit", amountWei: "10", extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const backup = join(fixture.root, "alice-before-transfer.backup");
    expect((await cli.runOwnerCli(["backup", ...fixture.alice.args, "--out", backup])).status)
      .toBe("created");
    async function prepare(kind: "deposit" | "transfer", amountWei: string, extra: string[]) {
      const amountFile = join(fixture.root, `amount-${randomUUID()}.json`);
      await writeFile(amountFile, JSON.stringify({ amountWei }), { mode: 0o600 });
      const created = await cli.runOwnerCli(["create", ...fixture.alice.args, ...fixture.onlineArgs,
        "--kind", kind, "--amount-file", amountFile, ...extra]);
      const id = created.operationId as string;
      await cli.runOwnerCli(["prove", ...fixture.alice.args, "--id", id]);
      await cli.runOwnerCli(["authorize", ...fixture.alice.args, "--id", id,
        "--signer", fixture.alice.signer]);
      const publicFile = join(fixture.root, `${id}.json`);
      await cli.runOwnerCli(["export", ...fixture.alice.args, "--id", id, "--out", publicFile]);
      return { id, publicFile };
    }
    const transfer = await prepare("transfer", "3", ["--recipient", recipients.bob,
      "--change-recipient", recipients.alice]);
    await anvilRequest<boolean>(fixture.rpcUrl, "anvil_setAutomine", [false]);
    try {
      const pending = await cli.runSubmitterCli(["submit", ...fixture.submitterArgs,
        "--public", transfer.publicFile]);
      expect(pending.status).toBe("pending");
      const beforeMine = await cli.runResultCli(["operation", ...fixture.submitterArgs, "--id", transfer.id]);
      expect(beforeMine.value.status).toBe("pending");
      const bobBefore = await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
      expect(bobBefore.status).toBe("complete");
      expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(0n);
      await anvilRequest<string>(fixture.rpcUrl, "anvil_mine", ["0x1"]);
      const afterMine = await cli.runResultCli(["operation", ...fixture.submitterArgs, "--id", transfer.id]);
      expect(afterMine.value.status).toBe("executed");
    } finally { await anvilRequest<boolean>(fixture.rpcUrl, "anvil_setAutomine", [true]); }
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(3n);
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const deposit = await prepare("deposit", "1", ["--recipient", recipients.alice]);
    const proxy = await startRpcFaultProxy(fixture.rpcUrl);
    try {
      proxy.injectRpcFault({ method: "eth_sendRawTransaction", nth: 1, action: "error" });
      const proxyArgs = ["--journal", fixture.journal, "--manifest", fixture.manifestFile,
        "--rpc", proxy.rpcUrl, "--signer", fixture.submitter.signer,
        "--submitter", fixture.submitter.address];
      const lost = await cli.runResultCli(["submit", ...proxyArgs, "--public", deposit.publicFile]);
      expect(lost.value).toMatchObject({ kind: "submission", operationId: deposit.id, status: "unknown" });
    } finally { await proxy.close(); }
    const adopted = await cli.runResultCli(["operation", ...fixture.submitterArgs, "--id", deposit.id]);
    expect(adopted.value.status).toBe("executed");
    const retry = await cli.runResultCli(["retry", ...fixture.submitterArgs, "--id", deposit.id]);
    expect(retry.value.status).toBe("executed");
    const restored = join(fixture.root, "alice-restored");
    const restoredArgs = ["--store", restored, "--owner", fixture.alice.address];
    expect((await cli.runOwnerCli(["restore", ...restoredArgs, "--backup", backup])).status)
      .toBe("needs-resync");
    const recovered = await cli.runOwnerCli(["sync", ...restoredArgs, ...fixture.onlineArgs]);
    expect(recovered.status).toBe("complete");
    expect(await cli.readOwnerBalanceTTY(["balance", ...restoredArgs])).toBe(8n);
  });
}, 240_000);

it("S-15-reorg discards an adopted receipt when a block hash changes", async () => {
  await withCoreAnvil(async fixture => {
    const cli = createCli(fixture);
    const recipients = await prepareRecipients(fixture);
    await executeCliOperation(fixture, { ownerArgs: fixture.alice.args, signer: fixture.alice.signer,
      kind: "deposit", amountWei: "10", extra: ["--recipient", recipients.alice] });
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    const snapshot = await anvilRequest<string>(fixture.rpcUrl, "evm_snapshot");
    const sent = await executeCliOperation(fixture, { ownerArgs: fixture.alice.args,
      signer: fixture.alice.signer, kind: "transfer", amountWei: "3",
      extra: ["--recipient", recipients.bob, "--change-recipient", recipients.alice] });
    const oldReceipt = await fixture.client.getTransactionReceipt({ hash: sent.txHash });
    await cli.runOwnerCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(3n);
    expect(await anvilRequest<boolean>(fixture.rpcUrl, "evm_revert", [snapshot])).toBe(true);
    await anvilRequest<string>(fixture.rpcUrl, "evm_increaseTime", [10]);
    await anvilRequest<string>(fixture.rpcUrl, "evm_mine");
    const replacement = await fixture.client.getBlock({ blockNumber: oldReceipt.blockNumber });
    expect(replacement.hash).not.toBe(oldReceipt.blockHash);
    const bobSync = await cli.runResultCli(["sync", ...fixture.bob.args, ...fixture.onlineArgs]);
    expect(bobSync.value.status).toBe("complete");
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.bob.args])).toBe(0n);
    const attempt = await cli.runResultCli(["operation", ...fixture.submitterArgs, "--id", sent.operationId]);
    expect(attempt.value.status).not.toBe("executed");
    await cli.runOwnerCli(["sync", ...fixture.alice.args, ...fixture.onlineArgs]);
    expect(await cli.readOwnerBalanceTTY(["balance", ...fixture.alice.args])).toBe(10n);
  });
}, 180_000);
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
