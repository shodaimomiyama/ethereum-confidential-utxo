import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";
import { preflightSubmission, synchronize } from "@confidential-utxo/core";
import type { OperationRequest } from "@confidential-utxo/core";
import { verifyEthereumDeployment } from "../src/deployment.js";
import { createHistoryPort } from "../src/history.js";
import { defaultRpcPolicy } from "../src/rpc.js";

const require = createRequire(import.meta.url);
const { deployPool } = require("../../../scripts/pool-deployment.mjs") as {
  deployPool(options: { rpcUrl: string; expectedChainId: number; privateKey: string; hardfork: string }): Promise<unknown>;
};
const anvilKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function withIsolatedAnvil(run: (environment: { client: PublicClient; url: string }) => Promise<void>) {
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
      try { ready = await client.getChainId() === 31337; } catch { /* Wait for startup. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Anvil startup timed out");
    await run({ client, url });
  } finally {
    child.kill("SIGTERM");
  }
}

it("accepts only the fixed Pool and verifier deployment on the selected chain", async () => {
  await withIsolatedAnvil(async ({ client, url }) => {
    const manifest = await deployPool({ rpcUrl: url, expectedChainId: 31337, privateKey: anvilKey, hardfork: "cancun" });
    const verified = await verifyEthereumDeployment(client, manifest, "local-simulated");
    expect(verified.context.pool.toLowerCase()).toBe((manifest as { pool: { address: string } }).pool.address.toLowerCase());
    expect(verified.context.finalityMode).toBe("local-simulated");
    const history = createHistoryPort(verified, client, defaultRpcPolicy);
    const first = await history.getFinalizedCheckpoint();
    expect(first).not.toBeNull();
    const baseline = await history.getOperations(verified.context.deploymentBlock, first!);
    expect(baseline).toEqual({ complete: true, blockHash: first!.hash, value: [] });
    expect(await history.getOperations(verified.context.deploymentBlock, first!)).toEqual(baseline);
    const synchronized = await synchronize(verified.context, { history,
      owners: [verified.context.verifier], keys: { getKey: async () => { throw new Error("unused"); } } });
    expect(synchronized).toMatchObject({ status: "complete", availableWei: 0n, utxos: [] });
    const cases = JSON.parse(readFileSync("tests/vectors/cases/operation.json", "utf8"));
    const input = cases.find((item: { id: string }) => item.id === "VEC-01-DEPOSIT").input;
    const request: OperationRequest = { kind: 0, owner: input.owner, salt: input.salt, inputIds: [],
      outputs: input.outputs.map((output: { owner: string; Cx: string; Cy: string; packet: string }) => ({
        owner: output.owner, commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) },
        receiptFormat: 1, packet: output.packet,
      })), d: 1n, w: 0n, destination: input.destination };
    expect(await preflightSubmission(verified.context, request, { history })).toMatchObject({ status: "ready" });
    for (const mutate of [
      (copy: any) => { copy.schemaVersion = 2; },
      (copy: any) => { copy.chainId = 11155111; },
      (copy: any) => { copy.pool.address = "0x2222222222222222222222222222222222222222"; },
      (copy: any) => { copy.verifier.address = "0x2222222222222222222222222222222222222222"; },
      (copy: any) => { copy.parametersHash = `0x${"00".repeat(32)}`; },
      (copy: any) => { copy.pool.runtimeSha256 = "0".repeat(64); },
      (copy: any) => { copy.pool.constructorArgsSha256 = "0".repeat(64); },
      (copy: any) => { copy.pool.transactionHash = `0x${"00".repeat(32)}`; },
      (copy: any) => { copy.pool.blockNumber = "99999"; },
    ]) {
      const changed = structuredClone(manifest);
      mutate(changed);
      await expect(verifyEthereumDeployment(client, changed, "local-simulated"))
        .rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
    }
    const noLogs = new Proxy(client, { get(target, property) {
      if (property === "getLogs") return async () => { throw new Error("method unavailable"); };
      return Reflect.get(target, property);
    } }) as PublicClient;
    await expect(verifyEthereumDeployment(noLogs, manifest, "local-simulated"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    const noFinality = new Proxy(client, { get(target, property) {
      if (property === "getBlock") return async (options: { blockTag?: string }) => {
        if (options.blockTag === "finalized") throw new Error("finalized unsupported");
        return client.getBlock(options as Parameters<PublicClient["getBlock"]>[0]);
      };
      return Reflect.get(target, property);
    } }) as PublicClient;
    await expect(verifyEthereumDeployment(noFinality, manifest, "finalized"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    const disconnected = new Proxy(client, { get(target, property) {
      if (property === "getChainId") return async () => { throw new Error("https://rpc.invalid/SECRET_TOKEN"); };
      return Reflect.get(target, property);
    } }) as PublicClient;
    await expect(verifyEthereumDeployment(disconnected, manifest, "local-simulated"))
      .rejects.toMatchObject({ code: "RPC", message: "RPC:deployment.rpc" });
  });
}, 60_000);
