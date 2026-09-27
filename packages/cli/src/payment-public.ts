import { recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import type { Context, PublicSubmission } from "@confidential-utxo/core";
import { assertWithdrawalBinding, paymentDigest } from "@confidential-utxo/uniswap";
import type { PaymentDeployment, PaymentTerms } from "@confidential-utxo/uniswap";
import { decodePublicSubmission, encodePublicSubmission } from "./public-files.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";

const rootKeys = ["schemaVersion", "chainId", "deploymentId", "pool", "adapter", "operationId",
  "paymentId", "terms", "poolSubmission", "paymentSignature"];
const termKeys = ["operationId", "owner", "ethAmount", "token", "minAmountOut", "recipient", "deadline"];
const uint256 = (1n << 256n) - 1n;
const uint64 = (1n << 64n) - 1n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new Error("PAYMENT_PUBLIC_INVALID"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uint(value: unknown, limit = uint256): bigint {
  const result = decimalWei(value);
  if (result > limit) invalid();
  return result;
}
function address(value: unknown): Address { return hexBytes(value, 20) as Address; }
function hash(value: unknown): Hex { return hexBytes(value, 32); }
function signature(value: unknown): Hex { return hexBytes(value, 65); }
function termsObject(terms: PaymentTerms) {
  return { operationId: terms.operationId, owner: terms.owner, ethAmount: terms.ethAmount.toString(),
    token: terms.token, minAmountOut: terms.minAmountOut.toString(), recipient: terms.recipient,
    deadline: terms.deadline.toString() };
}
function parseTerms(value: unknown): PaymentTerms {
  const row = exact(value, termKeys);
  return { operationId: hash(row.operationId) as PaymentTerms["operationId"], owner: address(row.owner) as PaymentTerms["owner"],
    ethAmount: uint(row.ethAmount), token: address(row.token) as PaymentTerms["token"],
    minAmountOut: uint(row.minAmountOut), recipient: address(row.recipient) as PaymentTerms["recipient"],
    deadline: uint(row.deadline, uint64) };
}

export type PaymentPublicV1 = {
  readonly schemaVersion: 1;
  readonly chainId: bigint;
  readonly deploymentId: string;
  readonly pool: Address;
  readonly adapter: Address;
  readonly operationId: Hex;
  readonly paymentId: Hex;
  readonly terms: PaymentTerms;
  readonly poolSubmission: PublicSubmission;
  readonly paymentSignature: Hex;
};

export function encodePaymentPublic(context: Context, deploymentId: string, deployment: PaymentDeployment,
  terms: PaymentTerms, poolSubmission: PublicSubmission, paymentSignature: Hex): Uint8Array {
  if (!deploymentId || deploymentId.length > 256 || !same(context.pool, deployment.pool)) invalid();
  assertWithdrawalBinding({ context, request: poolSubmission.request,
    operationId: terms.operationId, rangeProofs: poolSubmission.rangeProofs }, terms, deployment);
  const serialized = JSON.parse(new TextDecoder().decode(encodePublicSubmission(context, poolSubmission)));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, chainId: context.chainId.toString(), deploymentId,
    pool: context.pool, adapter: deployment.adapter, operationId: terms.operationId,
    paymentId: paymentDigest(terms, context.chainId, deployment.adapter), terms: termsObject(terms),
    poolSubmission: serialized, paymentSignature: signature(paymentSignature) }), "utf8");
}

export async function decodePaymentPublic(bytes: Uint8Array, context: Context, deploymentId: string,
  deployment: PaymentDeployment): Promise<PaymentPublicV1> {
  if (bytes.length > 2 * 1024 * 1024) invalid();
  const root = exact(parseExactObject(bytes, rootKeys), rootKeys);
  if (root.schemaVersion !== 1 || uint(root.chainId) !== context.chainId ||
    root.deploymentId !== deploymentId || !same(address(root.pool), context.pool) ||
    !same(address(root.adapter), deployment.adapter) || !same(deployment.pool, context.pool)) invalid();
  const terms = parseTerms(root.terms);
  const poolSubmission = await decodePublicSubmission(Buffer.from(JSON.stringify(root.poolSubmission)), context);
  const operationId = hash(root.operationId);
  const paymentId = hash(root.paymentId);
  const paymentSignature = signature(root.paymentSignature);
  if (!same(terms.operationId, operationId) ||
    !same(paymentId, paymentDigest(terms, context.chainId, deployment.adapter))) invalid();
  assertWithdrawalBinding({ context, request: poolSubmission.request,
    operationId: terms.operationId, rangeProofs: poolSubmission.rangeProofs }, terms, deployment);
  const signer = await recoverTypedDataAddress({ domain: { name: "Ethereum Confidential UTXO Uniswap Payment",
    version: "1", chainId: context.chainId, verifyingContract: deployment.adapter },
  types: { PaymentAuthorization: [ { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
    { name: "ethAmount", type: "uint256" }, { name: "token", type: "address" },
    { name: "minAmountOut", type: "uint256" }, { name: "recipient", type: "address" },
    { name: "deadline", type: "uint64" } ] }, primaryType: "PaymentAuthorization", message: terms,
  signature: paymentSignature });
  if (!same(signer, terms.owner)) invalid();
  return { schemaVersion: 1, chainId: context.chainId, deploymentId, pool: context.pool,
    adapter: deployment.adapter, operationId, paymentId, terms, poolSubmission, paymentSignature };
}
