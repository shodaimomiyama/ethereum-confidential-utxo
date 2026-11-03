import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import type { DeploymentManifestV1 } from "@confidential-utxo/ethereum";
import { withCoreAnvil } from "./anvil.js";
import { createCli } from "./cli.js";

it("official fixture deploys Pool and runs real CLI", async () => {
  await withCoreAnvil(async fixture => {
    const { rpcUrl, manifestFile, client, alice, bob } = fixture;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as DeploymentManifestV1;
    const verified = await verifyEthereumDeployment(client, manifest, "local-simulated");
    expect(verified.context.pool).toBe(manifest.pool.address);
    expect(await client.getCode({ address: verified.context.pool })).not.toBe("0x");
    expect(await client.getCode({ address: verified.context.verifier })).not.toBe("0x");
    expect(rpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const cli = createCli(fixture);
    expect(await cli.runOwnerCli(["init", ...alice.args, ...fixture.onlineArgs]))
      .toMatchObject({ kind: "init" });
    expect(await cli.runOwnerCli(["key", "add", ...alice.args]))
      .toMatchObject({ kind: "key" });
    expect(await cli.runOwnerCli(["init", ...bob.args, ...fixture.onlineArgs]))
      .toMatchObject({ kind: "init" });
    expect(await cli.runOwnerCli(["key", "add", ...bob.args]))
      .toMatchObject({ kind: "key" });
  });
}, 120_000);
