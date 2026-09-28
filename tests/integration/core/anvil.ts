import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import type { Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { poolAbi, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import type { DeploymentManifestV1 } from "@confidential-utxo/ethereum";
import { expect } from "vitest";

const require = createRequire(import.meta.url);
const { deployPool } = require("../../../scripts/pool-deployment.mjs") as {
  deployPool(input: { rpcUrl: string; expectedChainId: number; privateKey: string; hardfork: string }): Promise<DeploymentManifestV1>;
};
// These deterministic keys are exclusively for disposable local Anvil fixtures.
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const aliceKey = `0x${"01".repeat(32)}` as const;
const bobKey = `0x${"02".repeat(32)}` as const;
const submitterKey = `0x${"42".repeat(32)}` as const;

export type TestActor = { address: Address; signer: string; store: string; args: string[] };
export type CoreAnvilFixture = {
  rpcUrl: string;
  manifestFile: string;
  manifest: DeploymentManifestV1;
  root: string;
  client: PublicClient;
  alice: TestActor;
  bob: TestActor;
  submitter: TestActor;
  journal: string;
  onlineArgs: string[];
  submitterArgs: string[];
  terminalScript: string;
  recordedOperations: Map<string, { operationId: `0x${string}`; txHash: `0x${string}` }[]>;
  recordOperation(caseIds: string[], operationId: `0x${string}`, txHash: `0x${string}`): void;
};

async function recordPublicTransactions(fixture: CoreAnvilFixture, outputDir: string, title: string) {
  const caseIds = [...new Set(title.match(/\bS-\d{2}-[a-z0-9-]+\b/g) ?? [])];
  if (caseIds.length === 0) return;
  for (const [caseId, attempts] of fixture.recordedOperations) {
    if (!caseIds.includes(caseId)) throw new Error(`transaction case absent from test title: ${caseId}`);
    const transactions = [];
    for (const attempt of attempts) {
      const receipt = await fixture.client.getTransactionReceipt({ hash: attempt.txHash });
      const events = parseEventLogs({ abi: poolAbi, eventName: "OperationSucceeded",
        logs: receipt.logs, strict: false });
      if (receipt.status !== "success" || !events.some(event =>
        event.args.operationId?.toLowerCase() === attempt.operationId.toLowerCase()))
        throw new Error(`missing canonical operation event for ${caseId}`);
      transactions.push({ operationId: attempt.operationId, txHash: attempt.txHash,
        blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(), status: receipt.status });
    }
    await writeFile(join(outputDir, `transactions-${process.pid}-${randomUUID()}.json`),
      JSON.stringify({ caseIds: [caseId], transactions }), { flag: "wx", mode: 0o600 });
  }
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing Anvil port"));
      server.close(() => resolve(address.port));
    });
  });
}

export async function withCoreAnvil<T>(run: (fixture: CoreAnvilFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cutxo-core-"));
  const port = await unusedPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn("anvil", ["--silent", "--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--hardfork", "cancun", "--gas-limit", "30000000"], { stdio: "ignore" });
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try { ready = await client.getChainId() === 31337; } catch { /* Anvil is starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Anvil startup timed out");
    const manifest = await deployPool({ rpcUrl, expectedChainId: 31337, privateKey: deployerKey, hardfork: "cancun" });
    await verifyEthereumDeployment(client, manifest, "local-simulated");
    const manifestFile = join(root, "manifest.json");
    await writeFile(manifestFile, JSON.stringify(manifest));
    const keysDir = join(root, "keys");
    await mkdir(keysDir, { mode: 0o700 });
    const actors = await Promise.all(([ ["alice", aliceKey], ["bob", bobKey], ["submitter", submitterKey] ] as const)
      .map(async ([name, key]): Promise<TestActor> => {
        const address = privateKeyToAccount(key).address;
        const signer = join(keysDir, `${name}.key`);
        const store = join(root, name);
        await writeFile(signer, `${key}\n`, { mode: 0o600 });
        return { address, signer, store, args: ["--store", store, "--owner", address] };
      }));
    const [alice, bob, submitter] = actors as [TestActor, TestActor, TestActor];
    const funding = await createWalletClient({ account: privateKeyToAccount(deployerKey), chain: foundry,
      transport: http(rpcUrl) }).sendTransaction({ to: submitter.address, value: 10n ** 18n });
    await client.waitForTransactionReceipt({ hash: funding });
    const terminalScript = join(root, "terminal.exp");
    await writeFile(terminalScript, 'set timeout 120\nspawn {*}$argv\nexpect {\n  -re {(Passphrase|passphrase): } { send -- "secret\\r"; exp_continue }\n  eof {}\n}\nexit [lindex [wait] 3]\n');
    const onlineArgs = ["--manifest", manifestFile, "--rpc", rpcUrl];
    const journal = join(root, "journal");
    const submitterArgs = ["--journal", journal, ...onlineArgs, "--signer", submitter.signer,
      "--submitter", submitter.address];
    const recordedOperations = new Map<string, { operationId: `0x${string}`; txHash: `0x${string}` }[]>();
    const fixture = { rpcUrl, manifestFile, manifest, root, client, alice, bob, submitter,
      journal, onlineArgs, submitterArgs, terminalScript, recordedOperations,
      recordOperation: (caseIds: string[], operationId: `0x${string}`, txHash: `0x${string}`) => {
        for (const caseId of caseIds) recordedOperations.set(caseId,
          [...(recordedOperations.get(caseId) ?? []), { operationId, txHash }]);
      } };
    const title = expect.getState().currentTestName ?? "";
    const result = await run(fixture);
    if (process.env.CORE_PUBLIC_TX_DIR) await recordPublicTransactions(fixture, process.env.CORE_PUBLIC_TX_DIR, title);
    return result;
  } finally {
    child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}
