import { hashTypedData, recoverTypedDataAddress, zeroAddress } from "viem";
import type { Address, Hex, TypedDataDefinition } from "viem";
import { operationId, validateOperationShape } from "./encoding.js";
import { CoreFailure } from "./errors.js";
import type { Context, OperationAuthorizationTypedData, OperationRequest, SignerPort } from "./types.js";

type AuthorizationContext = Pick<Context, "chainId" | "pool">;
export type RecipientInfo = {
  chainId: bigint;
  pool: Address;
  owner: Address;
  receivePublicKey: Hex;
  receiptFormat: 1;
  recipientInfoVersion: 1;
  signature: Hex;
};
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function bytes(value: unknown, length: number): boolean {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value);
}
function requireInput(condition: boolean): asserts condition {
  if (!condition) throw new CoreFailure("INVALID_INPUT", "authorization.input");
}
function domain(context: AuthorizationContext): OperationAuthorizationTypedData["domain"] {
  requireInput(typeof context.chainId === "bigint" && context.chainId >= 0n && context.chainId < (1n << 256n));
  requireInput(bytes(context.pool, 20));
  return { name: "Ethereum Confidential UTXO", version: "1", chainId: context.chainId, verifyingContract: context.pool };
}
function operationTypedData(context: AuthorizationContext, id: Hex, owner: Address): OperationAuthorizationTypedData {
  requireInput(bytes(id, 32) && bytes(owner, 20) && owner.toLowerCase() !== zeroAddress);
  return {
    domain: domain(context), primaryType: "OperationAuthorization",
    types: { OperationAuthorization: [
      { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "authScheme", type: "uint8" }, { name: "authVersion", type: "uint8" },
    ] },
    message: { operationId: id, owner, authScheme: 1, authVersion: 1 },
  };
}
async function verifySignature(typed: TypedDataDefinition, owner: Address, signature: Hex): Promise<void> {
  try {
    if (!bytes(signature, 65)) throw new Error();
    const r = BigInt(`0x${signature.slice(2, 66)}`);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16);
    if (r < 1n || r >= SECP256K1_ORDER || s < 1n || s > SECP256K1_ORDER / 2n || (v !== 27 && v !== 28)) throw new Error();
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    if (recovered === zeroAddress || recovered.toLowerCase() !== owner.toLowerCase()) throw new Error();
  } catch {
    throw new CoreFailure("SIGNATURE_REJECTED", "authorization.signature");
  }
}
export function recipientInfoTypedData(context: AuthorizationContext, info: Omit<RecipientInfo, "signature">, expectedOwner: Address) {
  const recipientDomain = domain(context);
  requireInput(bytes(info.owner, 20) && bytes(expectedOwner, 20) && bytes(info.pool, 20));
  requireInput(info.owner.toLowerCase() !== zeroAddress && info.owner.toLowerCase() === expectedOwner.toLowerCase());
  requireInput(info.chainId === context.chainId && info.pool.toLowerCase() === context.pool.toLowerCase());
  requireInput(info.receiptFormat === 1 && info.recipientInfoVersion === 1 && bytes(info.receivePublicKey, 32));
  const typed = {
    domain: recipientDomain, primaryType: "RecipientInfo",
    types: { RecipientInfo: [
      { name: "owner", type: "address" }, { name: "receivePublicKey", type: "bytes32" },
      { name: "receiptFormat", type: "uint8" }, { name: "recipientInfoVersion", type: "uint8" },
    ] },
    message: { owner: info.owner, receivePublicKey: info.receivePublicKey, receiptFormat: info.receiptFormat, recipientInfoVersion: info.recipientInfoVersion },
  } as const;
  return typed;
}
export type RecipientInfoTypedData = ReturnType<typeof recipientInfoTypedData>;
export interface RecipientInfoSignerPort {
  signTypedData(data: RecipientInfoTypedData): Promise<Hex>;
}
export async function verifyRecipientInfo(context: AuthorizationContext, info: RecipientInfo, expectedOwner: Address): Promise<void> {
  await verifySignature(recipientInfoTypedData(context, info, expectedOwner), info.owner, info.signature);
}
export function authorizationTypedData(context: AuthorizationContext, request: OperationRequest): OperationAuthorizationTypedData {
  try {
    validateOperationShape(request);
    domain(context);
    return operationTypedData(context, operationId(context, request), request.owner);
  } catch {
    throw new CoreFailure("INVALID_INPUT", "authorization.input");
  }
}
export async function verifyOperationAuthorization(context: AuthorizationContext, id: Hex, owner: Address, signature: Hex): Promise<void> {
  await verifySignature(operationTypedData(context, id, owner), owner, signature);
}
function freezeTree(value: object): void {
  Object.values(value).forEach(child => { if (child !== null && typeof child === "object") freezeTree(child); });
  Object.freeze(value);
}
export async function authorizeOperation(context: AuthorizationContext, request: OperationRequest, signer: SignerPort): Promise<Hex> {
  const snapshot = authorizationTypedData(context, request);
  const expectedDigest = hashTypedData(snapshot);
  freezeTree(snapshot);
  let signature: Hex;
  try {
    signature = await signer.signTypedData(snapshot);
    await verifyOperationAuthorization({ chainId: snapshot.domain.chainId, pool: snapshot.domain.verifyingContract }, snapshot.message.operationId, snapshot.message.owner, signature);
  } catch {
    throw new CoreFailure("SIGNATURE_REJECTED", "authorization.signer");
  }
  try {
    if (hashTypedData(authorizationTypedData(context, request)) !== expectedDigest) throw new Error();
  } catch {
    throw new CoreFailure("INCONSISTENT", "authorization.mutation");
  }
  return signature;
}
