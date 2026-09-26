import { M, P, Q } from "@confidential-utxo/crypto";
import { operationId, validateOperationShape, verifyOperationAuthorization, verifyRecipientInfo } from "@confidential-utxo/core";
import type { Context, OperationRequest, PublicSubmission, RecipientInfo } from "@confidential-utxo/core";
import type { Address, Hex } from "viem";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";

const uint256 = (1n << 256n) - 1n;
function invalid(): never { throw new Error("PUBLIC_FILE_INVALID"); }
function exact(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== required.length || required.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function uint(value: unknown, max: bigint): bigint {
  const number = decimalWei(value);
  if (number > max) invalid();
  return number;
}
const address = (value: unknown) => hexBytes(value, 20) as Address;
const hash = (value: unknown) => hexBytes(value, 32);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function parseRequest(value: unknown): OperationRequest {
  const root = exact(value, ["kind", "owner", "salt", "inputIds", "outputs", "d", "w", "destination"]);
  if (root.kind !== 0 && root.kind !== 1 && root.kind !== 2) invalid();
  const request: OperationRequest = { kind: root.kind, owner: address(root.owner), salt: hash(root.salt),
    inputIds: list(root.inputIds, 2).map(hash), outputs: list(root.outputs, 2).map(value => {
      const output = exact(value, ["owner", "commitment", "receiptFormat", "packet"]);
      const point = exact(output.commitment, ["x", "y"]);
      if (output.receiptFormat !== 1) invalid();
      return { owner: address(output.owner), commitment: { x: uint(point.x, P - 1n), y: uint(point.y, P - 1n) },
        receiptFormat: 1 as const, packet: hexBytes(output.packet, 112) };
    }), d: uint(root.d, M), w: uint(root.w, 2n * M), destination: address(root.destination) };
  validateOperationShape(request);
  return request;
}
function parseProof(value: unknown) {
  const root = exact(value, ["Rx", "Ry", "s"]);
  return { Rx: uint(root.Rx, P - 1n), Ry: uint(root.Ry, P - 1n), s: uint(root.s, Q - 1n) };
}
function parseRange(value: unknown) {
  const root = exact(value, ["coords", "scalars", "ls", "rs"]);
  const numbers = (input: unknown, max: bigint, expected: number) => {
    const values = list(input, expected).map(item => uint(item, max));
    if (values.length !== expected) invalid();
    return values;
  };
  return { coords: numbers(root.coords, P - 1n, 10), scalars: numbers(root.scalars, Q - 1n, 5),
    ls: numbers(root.ls, P - 1n, 24), rs: numbers(root.rs, P - 1n, 24) };
}
function encodeRequest(request: OperationRequest) {
  return { kind: request.kind, owner: request.owner, salt: request.salt,
    inputIds: request.inputIds.map(id => id), outputs: request.outputs.map(output => ({
      owner: output.owner, commitment: { x: output.commitment.x.toString(), y: output.commitment.y.toString() },
      receiptFormat: output.receiptFormat, packet: output.packet,
    })), d: request.d.toString(), w: request.w.toString(), destination: request.destination };
}
const encodeRange = (proof: PublicSubmission["rangeProofs"][number]) => ({
  coords: proof.coords.map(String), scalars: proof.scalars.map(String), ls: proof.ls.map(String), rs: proof.rs.map(String),
});

export function encodePublicSubmission(context: Context, submission: PublicSubmission): Uint8Array {
  validateOperationShape(submission.request);
  if (typeof submission.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(submission.signature)) invalid();
  const id = operationId(context, submission.request);
  const file = { schemaVersion: 1, chainId: context.chainId.toString(), pool: context.pool, operationId: id,
    request: encodeRequest(submission.request), balanceProof: {
      Rx: submission.balanceProof.Rx.toString(), Ry: submission.balanceProof.Ry.toString(), s: submission.balanceProof.s.toString(),
    }, rangeProofs: submission.rangeProofs.map(encodeRange), signature: submission.signature };
  return Buffer.from(JSON.stringify(file), "utf8");
}

export async function decodePublicSubmission(bytes: Uint8Array, expectedContext: Context): Promise<PublicSubmission> {
  if (bytes.length > 2 * 1024 * 1024) invalid();
  const root = exact(parseExactObject(bytes, ["schemaVersion", "chainId", "pool", "operationId", "request", "balanceProof", "rangeProofs", "signature"]),
    ["schemaVersion", "chainId", "pool", "operationId", "request", "balanceProof", "rangeProofs", "signature"]);
  if (root.schemaVersion !== 1 || uint(root.chainId, uint256) !== expectedContext.chainId ||
      !same(address(root.pool), expectedContext.pool)) invalid();
  const request = parseRequest(root.request);
  const id = hash(root.operationId);
  if (!same(operationId(expectedContext, request), id)) invalid();
  const balanceProof = parseProof(root.balanceProof);
  const rangeProofs = list(root.rangeProofs, 2).map(parseRange);
  if (rangeProofs.length !== (request.kind === 0 ? 0 : request.outputs.length)) invalid();
  const signature = hexBytes(root.signature, 65);
  await verifyOperationAuthorization(expectedContext, id, request.owner, signature);
  return { request, balanceProof, rangeProofs, signature };
}

export function encodeRecipientInfo(info: RecipientInfo): Uint8Array {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, chainId: info.chainId.toString(), pool: info.pool,
    owner: info.owner, receivePublicKey: info.receivePublicKey, receiptFormat: info.receiptFormat,
    recipientInfoVersion: info.recipientInfoVersion, signature: info.signature }), "utf8");
}

export async function decodeRecipientInfo(bytes: Uint8Array, expectedContext: Context, expectedOwner: Address): Promise<RecipientInfo> {
  if (bytes.length > 4096) invalid();
  const root = exact(parseExactObject(bytes, ["schemaVersion", "chainId", "pool", "owner", "receivePublicKey", "receiptFormat", "recipientInfoVersion", "signature"]),
    ["schemaVersion", "chainId", "pool", "owner", "receivePublicKey", "receiptFormat", "recipientInfoVersion", "signature"]);
  if (root.schemaVersion !== 1 || root.receiptFormat !== 1 || root.recipientInfoVersion !== 1) invalid();
  const info: RecipientInfo = { chainId: uint(root.chainId, uint256), pool: address(root.pool), owner: address(root.owner),
    receivePublicKey: hash(root.receivePublicKey), receiptFormat: 1, recipientInfoVersion: 1, signature: hexBytes(root.signature, 65) };
  if (info.chainId !== expectedContext.chainId || !same(info.pool, expectedContext.pool) || !same(info.owner, expectedOwner)) invalid();
  await verifyRecipientInfo(expectedContext, info, expectedOwner);
  return info;
}
