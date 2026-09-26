import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readOwnerState } from "../src/state.js";

const require = createRequire(import.meta.url);
const { deployPool } = require("../../../scripts/pool-deployment.mjs") as {
  deployPool(input: { rpcUrl: string; expectedChainId: number; privateKey: string; hardfork: string }): Promise<unknown>;
};
const bin = new URL("../dist/bin.js", import.meta.url).pathname;
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const aliceKey = `0x${"01".repeat(32)}` as const;
const bobKey = `0x${"02".repeat(32)}` as const;
const submitterKey = `0x${"42".repeat(32)}` as const;
const alice = privateKeyToAccount(aliceKey);
const bob = privateKeyToAccount(bobKey);
const submitter = privateKeyToAccount(submitterKey);

async function withAnvil(run: (url: string) => Promise<void>) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      server.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("anvil", ["--silent", "--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--hardfork", "cancun", "--gas-limit", "30000000"], { stdio: "ignore" });
  try {
    const client = createPublicClient({ transport: http(url) });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try { ready = await client.getChainId() === 31337; } catch { /* wait */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Anvil startup timed out");
    await run(url);
  } finally { child.kill("SIGTERM"); }
}

async function runCli(script: string, args: string[]) {
  const child = spawn("expect", [script, process.execPath, bin, ...args, "--json"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("exit", value => resolve(value ?? -1)); child.once("error", reject);
  });
  const jsonLines = output.split(/\r?\n/).filter(line => line.startsWith("{"));
  expect(jsonLines, output).toHaveLength(1);
  const result = JSON.parse(jsonLines[0]!) as Record<string, string>;
  expect(code, `${args[0]}: ${output}`).toBe(0);
  expect(result.kind, `${args[0]}: ${output}`).not.toBe("error");
  return result;
}

it("runs deposit, partial and whole transfers, aggregation, and withdrawal through separate CLI processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-anvil-cli-"));
  try {
    const script = join(root, "terminal.exp");
    await writeFile(script, 'set timeout 120\nspawn {*}$argv\nexpect {\n  -re {(Passphrase|passphrase): } { send -- "secret\\r"; exp_continue }\n  eof {}\n}\nexit [lindex [wait] 3]\n');
    await withAnvil(async url => {
      const publicClient = createPublicClient({ transport: http(url) });
      const manifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: deployerKey, hardfork: "cancun" });
      const manifestFile = join(root, "manifest.json");
      await writeFile(manifestFile, JSON.stringify(manifest));
      const keysDir = join(root, "keys");
      await mkdir(keysDir, { mode: 0o700 });
      const aliceSigner = join(keysDir, "alice.key");
      const bobSigner = join(keysDir, "bob.key");
      const submitterSigner = join(keysDir, "submitter.key");
      await Promise.all([
        writeFile(aliceSigner, `${aliceKey}\n`, { mode: 0o600 }),
        writeFile(bobSigner, `${bobKey}\n`, { mode: 0o600 }),
        writeFile(submitterSigner, `${submitterKey}\n`, { mode: 0o600 }),
      ]);
      const funding = await createWalletClient({ account: privateKeyToAccount(deployerKey),
        chain: foundry, transport: http(url) }).sendTransaction({ to: submitter.address, value: 10n ** 18n });
      await publicClient.waitForTransactionReceipt({ hash: funding });
      const aliceStore = join(root, "alice");
      const bobStore = join(root, "bob");
      const journal = join(root, "journal");
      const aliceArgs = ["--store", aliceStore, "--owner", alice.address];
      const bobArgs = ["--store", bobStore, "--owner", bob.address];
      const onlineArgs = ["--manifest", manifestFile, "--rpc", url];
      const senderArgs = ["--journal", journal, ...onlineArgs, "--signer", submitterSigner,
        "--submitter", submitter.address];
      const cli = (args: string[]) => runCli(script, args);
      await cli(["init", ...aliceArgs, ...onlineArgs]);
      await cli(["key", "add", ...aliceArgs]);
      await cli(["init", ...bobArgs, ...onlineArgs]);
      await cli(["key", "add", ...bobArgs]);
      const aliceRecipient = join(root, "alice-recipient.json");
      const bobRecipient = join(root, "bob-recipient.json");
      await cli(["recipient", ...aliceArgs, "--signer", aliceSigner, "--out", aliceRecipient]);
      await cli(["recipient", ...bobArgs, "--signer", bobSigner, "--out", bobRecipient]);
      await cli(["sync", ...aliceArgs, ...onlineArgs]);
      await cli(["sync", ...bobArgs, ...onlineArgs]);
      const gasBefore = await publicClient.getBalance({ address: submitter.address });
      const bobEthBefore = await publicClient.getBalance({ address: bob.address });

      async function operation(ownerArgs: string[], signerFile: string, kind: string,
        amount: string, extra: string[]) {
        const amountFile = join(keysDir, `amount-${randomUUID()}.json`);
        await writeFile(amountFile, JSON.stringify({ amountWei: amount }), { mode: 0o600 });
        const created = await cli(["create", ...ownerArgs, ...onlineArgs,
          "--kind", kind, "--amount-file", amountFile, ...extra]);
        const id = created.operationId!;
        await cli(["prove", ...ownerArgs, "--id", id]);
        await cli(["authorize", ...ownerArgs, "--id", id, "--signer", signerFile]);
        const publicFile = join(root, `${id}.json`);
        await cli(["export", ...ownerArgs, "--id", id, "--out", publicFile]);
        const submitted = await cli(["submit", ...senderArgs, "--public", publicFile]);
        expect(submitted.status).toBe("pending");
        const receipt = await publicClient.waitForTransactionReceipt({ hash: submitted.txHash as `0x${string}` });
        expect(receipt.status).toBe("success");
        const observed = await cli(["operation", ...senderArgs, "--id", id]);
        expect(observed.status).toBe("executed");
      }

      await operation(aliceArgs, aliceSigner, "deposit", "10", ["--recipient", aliceRecipient]);
      await cli(["sync", ...aliceArgs, ...onlineArgs]);
      await operation(aliceArgs, aliceSigner, "transfer", "3", ["--recipient", bobRecipient,
        "--change-recipient", aliceRecipient]);
      await cli(["sync", ...aliceArgs, ...onlineArgs]);
      await cli(["sync", ...bobArgs, ...onlineArgs]);
      expect((await readOwnerState(bobStore, Buffer.from("secret"))).sync?.status).toBe("complete");
      await operation(aliceArgs, aliceSigner, "deposit", "2", ["--recipient", aliceRecipient]);
      await cli(["sync", ...aliceArgs, ...onlineArgs]);
      await operation(aliceArgs, aliceSigner, "transfer", "9", ["--recipient", bobRecipient]);
      await cli(["sync", ...aliceArgs, ...onlineArgs]);
      await cli(["sync", ...bobArgs, ...onlineArgs]);
      const aliceState = await readOwnerState(aliceStore, Buffer.from("secret"));
      const bobState = await readOwnerState(bobStore, Buffer.from("secret"));
      expect(aliceState.sync?.status === "complete" && aliceState.sync.availableWei).toBe(0n);
      expect(bobState.sync?.status === "complete" && bobState.sync.availableWei).toBe(12n);
      expect(bobState.sync?.status === "complete" && bobState.sync.utxos.filter(item => item.status === "available")).toHaveLength(2);
      await operation(bobArgs, bobSigner, "withdraw", "12", ["--destination", bob.address]);
      await cli(["sync", ...bobArgs, ...onlineArgs]);
      const finalBob = await readOwnerState(bobStore, Buffer.from("secret"));
      expect(finalBob.sync?.status === "complete" && finalBob.sync.availableWei).toBe(0n);
      expect(await publicClient.getBalance({ address: bob.address })).toBe(bobEthBefore + 12n);
      expect(await publicClient.getBalance({ address: submitter.address })).toBeLessThan(gasBefore - 12n);
      const publicBalance = await cli(["balance", ...bobArgs]);
      expect(publicBalance).toMatchObject({ kind: "balance", status: "available" });
      expect(JSON.stringify(publicBalance)).not.toContain("availableWei");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 300_000);
