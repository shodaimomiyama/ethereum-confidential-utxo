import { M, validateCommitment } from "@confidential-utxo/crypto";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, zeroAddress } from "viem";
import type { Hex } from "viem";
import { CoreFailure } from "./errors.js";
import type { Context, OperationRequest } from "./types.js";

type EncodingContext = Pick<Context, "chainId" | "pool">;
const tag = (label: string) => keccak256(stringToHex(label));
const INFO_TAG = tag("ecu/hpke-info/v1");
const OUTPUT_TAG = tag("ecu/output/v1");
const INPUTS_TAG = tag("ecu/inputs/v1");
const OUTPUTS_TAG = tag("ecu/outputs/v1");
const OP_TAG = tag("ecu/operation/v1");
const OUTPUT_ID_TAG = tag("ecu/output-id/v1");

function requireInput(condition: boolean, stage: string): asserts condition {
  if (!condition) throw new CoreFailure("INVALID_INPUT", `encoding.${stage}`);
}
function bytes(value: unknown, length: number): boolean {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value);
}
function uint(value: unknown, bits = 256): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < (1n << BigInt(bits));
}
function position(index: number | bigint): bigint {
  requireInput(typeof index === "bigint" || Number.isSafeInteger(index), "index");
  const value = BigInt(index);
  requireInput(uint(value), "index");
  return value;
}

/** Checks public request shape; accepting or submitting a request must call this explicitly.
 * Hashing alone does not validate ownership, amount proofs, signatures, or request shape.
 */
export function validateOperationShape(request: OperationRequest): void {
  requireInput([0, 1, 2].includes(request.kind), "kind");
  requireInput(bytes(request.owner, 20) && bytes(request.destination, 20), "address");
  requireInput(bytes(request.salt, 32), "salt");
  requireInput(uint(request.d) && uint(request.w), "amount");
  requireInput(Array.isArray(request.inputIds) && Array.isArray(request.outputs), "arrays");
  request.inputIds.forEach((id, i) => {
    requireInput(bytes(id, 32), "inputs");
    requireInput(i === 0 || BigInt(id) > BigInt(request.inputIds[i - 1]!), "inputs");
  });
  for (const output of request.outputs) {
    requireInput(bytes(output.owner, 20), "output.owner");
    requireInput(output.receiptFormat === 1 && bytes(output.packet, 112), "output.receipt");
    requireInput(uint(output.commitment.x) && uint(output.commitment.y), "output.commitment");
    try { validateCommitment(output.commitment); }
    catch { throw new CoreFailure("INVALID_INPUT", "encoding.output.commitment"); }
  }
  const inputs = request.inputIds.length;
  const outputs = request.outputs.length;
  const ownOutput = (i: number) => request.outputs[i]!.owner.toLowerCase() === request.owner.toLowerCase();
  if (request.kind === 0) {
    requireInput(inputs === 0 && outputs === 1 && ownOutput(0), "deposit.outputs");
    requireInput(request.d >= 1n && request.d <= M && request.w === 0n, "deposit.amount");
  } else {
    requireInput(inputs >= 1 && inputs <= 2 && request.d === 0n, "inputs");
    if (request.kind === 1) {
      requireInput(outputs >= 1 && outputs <= 2 && (outputs === 1 || ownOutput(1)), "transfer.outputs");
      requireInput(request.w === 0n, "transfer.amount");
    } else {
      requireInput(outputs <= 1 && (outputs === 0 || ownOutput(0)), "withdraw.outputs");
      requireInput(request.w >= 1n && request.w <= 2n * M, "withdraw.amount");
    }
  }
  requireInput(request.kind === 2 || request.destination === zeroAddress, "destination");
}

/** Computes receipt context before packet encryption; packet bytes are deliberately unused. */
export function receiptInfo(context: EncodingContext, request: OperationRequest, index: number): Hex {
  const i = position(index);
  const output = request.outputs[index];
  requireInput(output !== undefined, "index");
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,uint256,address,uint8,bytes32,uint256,address,uint256,uint256,uint8"),
    [INFO_TAG, context.chainId, context.pool, request.kind, request.salt, i, output.owner,
      output.commitment.x, output.commitment.y, output.receiptFormat],
  ));
}

/** Raw canonical ABI encoding, including semantically invalid requests for binding checks.
 * Call validateOperationShape before adopting this request for an operation.
 */
export function operationPreimage(context: EncodingContext, request: OperationRequest): Hex {
  const arrayAbi = parseAbiParameters("bytes32,bytes32[]");
  const inputsHash = keccak256(encodeAbiParameters(arrayAbi, [INPUTS_TAG, request.inputIds]));
  const hashes = request.outputs.map((output, i) => keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,uint256,address,uint256,uint256,uint8,bytes32"),
    [OUTPUT_TAG, BigInt(i), output.owner, output.commitment.x, output.commitment.y,
      output.receiptFormat, keccak256(output.packet)],
  )));
  const outputsHash = keccak256(encodeAbiParameters(arrayAbi, [OUTPUTS_TAG, hashes]));
  return encodeAbiParameters(
    parseAbiParameters("bytes32,uint256,address,uint8,address,bytes32,bytes32,bytes32,uint256,uint256,address"),
    [OP_TAG, context.chainId, context.pool, request.kind, request.owner, request.salt,
      inputsHash, outputsHash, request.d, request.w, request.destination],
  );
}

/** Hashes the raw encoding; this is not a request acceptance check. */
export function operationId(context: EncodingContext, request: OperationRequest): Hex {
  return keccak256(operationPreimage(context, request));
}

export function outputId(id: Hex, index: number | bigint): Hex {
  requireInput(bytes(id, 32), "operationId");
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,uint256"),
    [OUTPUT_ID_TAG, id, position(index)]));
}
