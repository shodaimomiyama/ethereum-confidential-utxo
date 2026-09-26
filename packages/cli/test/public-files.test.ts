import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildOperation, recipientInfoTypedData, toPublicSubmission } from "@confidential-utxo/core";
import type { Context, RecipientInfo } from "@confidential-utxo/core";
import { privateKeyToAccount } from "viem/accounts";
import { decodePublicSubmission, encodePublicSubmission, decodeRecipientInfo, encodeRecipientInfo } from "../src/public-files.js";

const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/authorization.json", import.meta.url), "utf8"));
const vector = vectors.find((item: {id:string}) => item.id === "VEC-02-RECIPIENT-SIGNATURE");
const account = privateKeyToAccount(vector.input.testOnlyPrivateKey);
const context: Context = { chainId: 31337n, pool: vector.input.pool, deploymentBlock: 0n,
  verifier: vector.input.pool, parametersHash: `0x${"00".repeat(32)}`, finalityMode: "finalized" };
const recipient = (): RecipientInfo => ({ ...vector.input, chainId: BigInt(vector.input.chainId) });
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it("accepts an exact public submission and rejects secret or changed fields", async () => {
  const draft = await buildOperation({ kind: 0, owner: account.address, amount: 1n, recipient: recipient() },
    context, { inputs: [], randomSalt: () => new Uint8Array(32).fill(7) });
  const signature = await account.signTypedData({
    domain: { name: "Ethereum Confidential UTXO", version: "1", chainId: context.chainId, verifyingContract: context.pool },
    primaryType: "OperationAuthorization", types: { OperationAuthorization: [
      { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "authScheme", type: "uint8" }, { name: "authVersion", type: "uint8" },
    ] }, message: { operationId: draft.operationId, owner: account.address, authScheme: 1, authVersion: 1 },
  });
  const publicFile = encodePublicSubmission(context, toPublicSubmission({ ...draft, signature }));
  expect(await decodePublicSubmission(publicFile, context)).toEqual(toPublicSubmission({ ...draft, signature }));
  const original = parse(publicFile);
  expect(original.request.d).toBe("1");
  for (const changed of [
    { ...original, openings: draft.openings.map(opening => ({ amount: opening.amount.toString(), blinding: opening.blinding.toString() })) },
    { ...original, secretKey: "0x01" },
    { ...original, chainId: "1" },
    { ...original, pool: account.address },
    { ...original, request: { ...original.request, d: 1 } },
    { ...original, operationId: `0x${"ff".repeat(32)}` },
    { ...original, signature: `0x${"01".repeat(65)}` },
  ]) await expect(decodePublicSubmission(encode(changed), context)).rejects.toThrow();
});

it("round-trips signed public recipient info with exact fields", async () => {
  const info = recipient();
  const bytes = encodeRecipientInfo(info);
  const { testOnlyPrivateKey: _, ...publicInfo } = info as RecipientInfo & { testOnlyPrivateKey: string };
  expect(await decodeRecipientInfo(bytes, context, info.owner)).toEqual(publicInfo);
  const changed = parse(bytes);
  changed.secretKey = "hidden";
  await expect(decodeRecipientInfo(encode(changed), context, info.owner)).rejects.toThrow();
  const other = { ...info, signature: await account.signTypedData(recipientInfoTypedData(context, info, info.owner)) };
  expect(await decodeRecipientInfo(encodeRecipientInfo(other), context, info.owner)).toEqual({ ...publicInfo, signature: other.signature });
});
