import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fixOperation } from "@confidential-utxo/core";
import type { Context, PublicSubmission, RecipientInfo } from "@confidential-utxo/core";
import { privateKeyToAccount } from "viem/accounts";
import { paymentDigest } from "@confidential-utxo/uniswap";
import type { PaymentDeployment, PaymentTerms } from "@confidential-utxo/uniswap";
import { decodePaymentPublic, encodePaymentPublic } from "../src/payment-public.js";

const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/authorization.json", import.meta.url), "utf8"));
const vector = vectors.find((item: { id: string }) => item.id === "VEC-02-RECIPIENT-SIGNATURE");
export const account = privateKeyToAccount(vector.input.testOnlyPrivateKey);
export const context: Context = { chainId: 31337n, pool: vector.input.pool, deploymentBlock: 0n,
  verifier: vector.input.pool, parametersHash: `0x${"00".repeat(32)}`, finalityMode: "local-simulated" };
export const recipient: RecipientInfo = { ...vector.input, chainId: BigInt(vector.input.chainId) };
export const deployment: PaymentDeployment = { adapter: "0x4444444444444444444444444444444444444444" as never,
  pool: context.pool as never, router: "0x5555555555555555555555555555555555555555" as never,
  factory: "0x6666666666666666666666666666666666666666" as never,
  weth: "0x7777777777777777777777777777777777777777" as never,
  pair: "0x8888888888888888888888888888888888888888" as never,
  token: "0x9999999999999999999999999999999999999999" as never };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export async function fixture() {
  const deposit = await fixOperation({ kind: 0, owner: account.address, amount: 7n, recipient }, context,
    { inputs: [], randomSalt: () => new Uint8Array(32).fill(3) });
  const input = { id: deposit.outputIds[0]!, owner: account.address, opening: deposit.openings[0]!,
    commitment: deposit.request.outputs[0]!.commitment,
    checkpoint: { number: 1n, hash: `0x${"aa".repeat(32)}` as const, mode: "local-simulated" as const },
    status: "available" as const, chainId: context.chainId, pool: context.pool };
  const fixed = await fixOperation({ kind: 2, owner: account.address, amount: 3n,
    destination: deployment.adapter, changeRecipient: recipient, explicitIds: [input.id] }, context,
  { inputs: [input], randomSalt: () => new Uint8Array(32).fill(4) });
  const terms: PaymentTerms = { operationId: fixed.operationId as never, owner: account.address as never,
    ethAmount: 3n, token: deployment.token, minAmountOut: 1n, recipient: account.address as never, deadline: 1000n };
  const signature = await account.signTypedData({ domain: { name: "Ethereum Confidential UTXO", version: "1",
    chainId: context.chainId, verifyingContract: context.pool }, primaryType: "OperationAuthorization",
  types: { OperationAuthorization: [ { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
    { name: "authScheme", type: "uint8" }, { name: "authVersion", type: "uint8" } ] },
  message: { operationId: fixed.operationId, owner: account.address, authScheme: 1, authVersion: 1 } });
  const paymentSignature = await account.signTypedData({ domain: {
    name: "Ethereum Confidential UTXO Uniswap Payment", version: "1", chainId: context.chainId,
    verifyingContract: deployment.adapter }, primaryType: "PaymentAuthorization",
  types: { PaymentAuthorization: [ { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
    { name: "ethAmount", type: "uint256" }, { name: "token", type: "address" },
    { name: "minAmountOut", type: "uint256" }, { name: "recipient", type: "address" },
    { name: "deadline", type: "uint64" } ] }, message: terms });
  const range = { coords: Array<bigint>(10).fill(0n), scalars: Array<bigint>(5).fill(0n),
    ls: Array<bigint>(12).fill(0n), rs: Array<bigint>(12).fill(0n) };
  const submission: PublicSubmission = { request: fixed.request,
    balanceProof: { Rx: 0n, Ry: 0n, s: 0n }, rangeProofs: [range], signature };
  return { terms, submission, paymentSignature, fixed, input };
}

it("exports a strict signed payment that an independent submitter can decode", async () => {
  const { terms, submission, paymentSignature } = await fixture();
  const exported = encodePaymentPublic(context, "local-v1", deployment, terms, submission, paymentSignature);
  const decoded = await decodePaymentPublic(exported, context, "local-v1", deployment);
  expect(decoded.paymentId).toBe(paymentDigest(terms, context.chainId, deployment.adapter));
  expect(decoded.terms.ethAmount).toBe(3n);
  expect(new TextDecoder().decode(exported)).not.toContain("blinding");
  const original = JSON.parse(new TextDecoder().decode(exported));
  for (const changed of [
    { ...original, deploymentId: "other" },
    { ...original, paymentId: `0x${"ff".repeat(32)}` },
    { ...original, paymentSignature: `0x${"ff".repeat(65)}` },
    { ...original, terms: { ...original.terms, minAmountOut: "2" } },
    { ...original, terms: { ...original.terms, ethAmount: "4" } },
    { ...original, terms: { ...original.terms, token: deployment.weth } },
    { ...original, terms: { ...original.terms, recipient: deployment.weth } },
    { ...original, terms: { ...original.terms, deadline: "1001" } },
    { ...original, terms: { ...original.terms, owner: deployment.weth } },
    { ...original, operationId: `0x${"ee".repeat(32)}` },
    { ...original, adapter: deployment.weth },
    { ...original, chainId: "11155111" },
    { ...original, privateKey: "hidden" },
  ]) await expect(decodePaymentPublic(bytes(changed), context, "local-v1", deployment)).rejects.toThrow();
});
