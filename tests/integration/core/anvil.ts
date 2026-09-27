import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import type { DeploymentManifestV1 } from "@confidential-utxo/ethereum";

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
};

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
    return await run({ rpcUrl, manifestFile, manifest, root, client, alice, bob, submitter,
      journal, onlineArgs, submitterArgs, terminalScript });
  } finally {
    child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}
