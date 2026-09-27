import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import type { CoreAnvilFixture } from "./anvil.js";
import { createCli } from "./cli.js";

export type CliOperationInput = {
  ownerArgs: string[];
  signer: string;
  kind: "deposit" | "transfer" | "withdraw";
  amountWei: string;
  extra: string[];
};

export async function executeCliOperation(fixture: CoreAnvilFixture, input: CliOperationInput): Promise<{
  operationId: Hex; txHash: Hex;
}> {
  const cli = createCli(fixture);
  const amountFile = join(fixture.root, `amount-${randomUUID()}.json`);
  await writeFile(amountFile, JSON.stringify({ amountWei: input.amountWei }), { mode: 0o600 });
  const created = await cli.runOwnerCli(["create", ...input.ownerArgs, ...fixture.onlineArgs,
    "--kind", input.kind, "--amount-file", amountFile, ...input.extra]);
  const operationId = created.operationId;
  if (typeof operationId !== "string" || !/^0x[0-9a-f]{64}$/i.test(operationId)) {
    throw new Error("CLI create omitted operationId");
  }
  await cli.runOwnerCli(["prove", ...input.ownerArgs, "--id", operationId]);
  await cli.runOwnerCli(["authorize", ...input.ownerArgs, "--id", operationId, "--signer", input.signer]);
  const publicFile = join(fixture.root, `${operationId}.json`);
  await cli.runOwnerCli(["export", ...input.ownerArgs, "--id", operationId, "--out", publicFile]);
  const submitted = await cli.runSubmitterCli(["submit", ...fixture.submitterArgs, "--public", publicFile]);
  const txHash = submitted.txHash;
  if (submitted.status !== "pending" || typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error("CLI submit did not return pending transaction");
  }
  const receipt = await fixture.client.waitForTransactionReceipt({ hash: txHash as Hex });
  if (receipt.status !== "success") throw new Error("CLI submitted transaction reverted");
  const observed = await cli.runSubmitterCli(["operation", ...fixture.submitterArgs, "--id", operationId]);
  if (observed.status !== "executed") throw new Error("CLI operation was not executed");
  return { operationId: operationId as Hex, txHash: txHash as Hex };
}
