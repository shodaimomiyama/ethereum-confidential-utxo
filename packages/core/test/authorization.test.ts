import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { concat, hashDomain, hashStruct, hashTypedData, keccak256, recoverTypedDataAddress, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recipientInfoTypedData, authorizationTypedData, authorizeOperation, CoreFailure, verifyOperationAuthorization, verifyRecipientInfo } from "../src/index.js";
import type { OperationRequest, RecipientInfo } from "../src/index.js";

type Vector = { id: string; input: { chainId: string; pool: Address; owner: Address; operationId: Hex; signature: Hex; receivePublicKey: Hex; receiptFormat: 1; recipientInfoVersion: 1; testOnlyPrivateKey: Hex }; expected: { decision: string; digest: Hex; domainSeparator: { hash: Hex }; recoveredOwner: Address } };
const vectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/authorization.json", import.meta.url), "utf8")) as Vector[];
const operationVector = vectors.find(v => v.id === "VEC-02-OPERATION-SIGNATURE")!;
type OperationVector = { input: Omit<OperationRequest, "d" | "w" | "outputs"> & {
  d: string; w: string; outputs: { owner: Address; Cx: string; Cy: string; receiptFormat: 1; packet: Hex }[];
}; expected: { operationId: Hex } };
const operationVectors = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/operation.json", import.meta.url), "utf8")) as OperationVector[];
function signedVectorRequest(): OperationRequest {
  const input = operationVectors.find(v => v.expected.operationId === operationVector.input.operationId)!.input;
  return { ...input, d: BigInt(input.d), w: BigInt(input.w), outputs: input.outputs.map(output => ({
    owner: output.owner, commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) }, receiptFormat: output.receiptFormat, packet: output.packet,
  })) };
}
const recipientVector = vectors.find(v => v.id === "VEC-02-RECIPIENT-SIGNATURE")!;
const context = { chainId: 31337n, pool: operationVector.input.pool };
const account = privateKeyToAccount(operationVector.input.testOnlyPrivateKey);
function recipient(): RecipientInfo { return { ...recipientVector.input, chainId: 31337n }; }
function request(): OperationRequest {
  return { kind: 2, owner: account.address, salt: `0x${"11".repeat(32)}`, inputIds: [`0x${"22".repeat(32)}`], outputs: [], d: 0n, w: 1n, destination: account.address };
}
const domainFields = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] as const;
describe("AC-01: authorization vectors", () => {
  it.each(vectors)("enforces $id", async ({ input, expected }) => {
    const ctx = { chainId: BigInt(input.chainId), pool: input.pool };
    const verification = input.receivePublicKey
      ? verifyRecipientInfo(context, { ...input, chainId: BigInt(input.chainId) }, recipientVector.input.owner)
      : verifyOperationAuthorization(ctx, input.operationId, input.owner, input.signature);
    if (expected.decision === "accept") await expect(verification).resolves.toBeUndefined();
    else await expect(verification).rejects.toBeInstanceOf(CoreFailure);
  });
  it("matches the operation domain, type, digest and recovered owner", async () => {
    const typed = authorizationTypedData(context, signedVectorRequest());
    expect(typed.domain).toEqual({ name: "Ethereum Confidential UTXO", version: "1", chainId: 31337n, verifyingContract: context.pool });
    expect(typed.primaryType).toBe("OperationAuthorization");
    expect(typed.types.EIP712Domain).toEqual(domainFields);
    expect(typed.types.OperationAuthorization).toEqual([
      { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "authScheme", type: "uint8" }, { name: "authVersion", type: "uint8" },
    ]);
    expect(typed.message).toEqual({ operationId: operationVector.input.operationId, owner: operationVector.input.owner, authScheme: 1, authVersion: 1 });
    expect(hashDomain({ domain: typed.domain, types: { EIP712Domain: domainFields } })).toBe(operationVector.expected.domainSeparator.hash);
    expect(hashTypedData(typed)).toBe(operationVector.expected.digest);
    const rpc = JSON.parse(JSON.stringify(typed, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as typeof typed;
    const rpcDomain = hashDomain({ domain: rpc.domain, types: { EIP712Domain: rpc.types.EIP712Domain } });
    const rpcMessage = hashStruct({ data: rpc.message, primaryType: rpc.primaryType, types: { OperationAuthorization: rpc.types.OperationAuthorization } });
    expect(keccak256(concat(["0x1901", rpcDomain, rpcMessage]))).toBe(operationVector.expected.digest);
    expect((await recoverTypedDataAddress({ ...typed, signature: operationVector.input.signature })).toLowerCase()).toBe(operationVector.expected.recoveredOwner);
  });
  it("matches the recipient domain, type, digest and recovered owner", async () => {
    const typed = recipientInfoTypedData(context, recipient(), recipientVector.input.owner);
    expect(typed.types.EIP712Domain).toEqual(domainFields);
    expect(hashDomain({ domain: typed.domain, types: { EIP712Domain: domainFields } })).toBe(recipientVector.expected.domainSeparator.hash);
    expect(hashTypedData(typed)).toBe(recipientVector.expected.digest);
    const rpc = JSON.parse(JSON.stringify(typed, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as typeof typed;
    const rpcDomain = hashDomain({ domain: rpc.domain, types: { EIP712Domain: rpc.types.EIP712Domain } });
    const rpcMessage = hashStruct({ data: rpc.message, primaryType: rpc.primaryType, types: { RecipientInfo: rpc.types.RecipientInfo } });
    expect(keccak256(concat(["0x1901", rpcDomain, rpcMessage]))).toBe(recipientVector.expected.digest);
    expect((await recoverTypedDataAddress({ ...typed, signature: recipient().signature })).toLowerCase()).toBe(recipientVector.expected.recoveredOwner);
  });
});

it.each([
  { chainId: 1n }, { pool: zeroAddress }, { owner: zeroAddress }, { receivePublicKey: "0x00" },
  { receiptFormat: 2 }, { recipientInfoVersion: 2 }, { signature: "0x" },
])("rejects changed recipient fields", async mutation => {
  await expect(verifyRecipientInfo(context, Object.assign(recipient(), mutation), account.address)).rejects.toBeInstanceOf(CoreFailure);
});
it("requires the expected recipient owner", async () => {
  await expect(verifyRecipientInfo(context, recipient(), context.pool)).rejects.toBeInstanceOf(CoreFailure);
});
it("authorizes an unchanged request with the actual owner", async () => {
  const operation = request();
  const signature = await authorizeOperation(context, operation, account);
  await expect(verifyOperationAuthorization(context, authorizationTypedData(context, operation).message.operationId, operation.owner, signature)).resolves.toBeUndefined();
});
it("rejects semantically invalid requests before asking the signer", async () => {
  const operation = request(); operation.d = 1n;
  const signTypedData = vi.fn();
  expect(() => authorizationTypedData(context, operation)).toThrow(CoreFailure);
  await expect(authorizeOperation(context, operation, { signTypedData })).rejects.toBeInstanceOf(CoreFailure);
  expect(signTypedData).not.toHaveBeenCalled();
});
it("AC-04: sanitizes untyped signer errors", async () => {
  await expect(authorizeOperation(context, request(), { signTypedData: async () => {
    throw new Error("secret request details");
  } })).rejects.toMatchObject({ code: "SIGNATURE_REJECTED", message: "SIGNATURE_REJECTED:authorization.signer" });
});
it("distinguishes an invalid returned signature from an explicit refusal", async () => {
  await expect(authorizeOperation(context, request(), { signTypedData: async () => "0x" as Hex }))
    .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
});
it("preserves a typed signer transport failure instead of reporting a refusal", async () => {
  await expect(authorizeOperation(context, request(), { signTypedData: async () => {
    throw new CoreFailure("RPC", "signer.transport");
  } })).rejects.toMatchObject({ code: "RPC", stage: "signer.transport" });
});
it("rejects changes to the caller request while the signer awaits", async () => {
  const operation = request();
  await expect(authorizeOperation(context, operation, { signTypedData: async typed => {
    operation.w = 2n;
    return account.signTypedData(typed);
  } })).rejects.toMatchObject({ code: "INCONSISTENT" });
});
it("rejects changes to context while the signer awaits", async () => {
  const ctx = { ...context };
  await expect(authorizeOperation(ctx, request(), { signTypedData: async typed => {
    ctx.chainId = 1n;
    return account.signTypedData(typed);
  } })).rejects.toMatchObject({ code: "INCONSISTENT" });
});
it("does not let a signer substitute the typed message or domain", async () => {
  await expect(authorizeOperation(context, request(), { signTypedData: async typed => {
    typed.message.owner = context.pool;
    typed.domain.chainId = 1n;
    return account.signTypedData(typed);
  } })).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
});

it.each(["authScheme", "authVersion"] as const)("rejects a signature using another %s", async field => {
  const operation = request();
  const typed = authorizationTypedData(context, operation);
  Object.assign(typed.message, { [field]: 2 });
  const signature = await account.signTypedData(typed);
  await expect(verifyOperationAuthorization(context, typed.message.operationId, operation.owner, signature)).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
});
it("rejects a different EIP-712 domain name or version", async () => {
  for (const mutation of [{ name: "Other protocol" }, { version: "2" }]) {
    const typed = authorizationTypedData(context, request());
    Object.assign(typed.domain, mutation);
    const signature = await account.signTypedData(typed);
    await expect(verifyOperationAuthorization(context, typed.message.operationId, typed.message.owner, signature)).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
  }
});
it("keeps the signer request deeply frozen and free of operation plaintext", async () => {
  await authorizeOperation(context, request(), { signTypedData: async typed => {
    expect(Object.keys(typed.message)).toEqual(["operationId", "owner", "authScheme", "authVersion"]);
    for (const value of [typed, typed.domain, typed.message, typed.types, typed.types.OperationAuthorization, ...typed.types.OperationAuthorization]) expect(Object.isFrozen(value)).toBe(true);
    return account.signTypedData(typed);
  } });
});
it("rejects nested caller request mutations", async () => {
  const operation = request();
  await expect(authorizeOperation(context, operation, { signTypedData: async typed => {
    operation.inputIds[0] = `0x${"33".repeat(32)}`;
    return account.signTypedData(typed);
  } })).rejects.toMatchObject({ code: "INCONSISTENT" });
});
it("applies canonical signature constraints to recipient information too", async () => {
  const original = recipient();
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = (order - BigInt(`0x${original.signature.slice(66, 130)}`)).toString(16).padStart(64, "0");
  for (const signature of [
    `${original.signature.slice(0, 66)}${highS}1b`,
    `${original.signature.slice(0, 130)}00`,
    `${original.signature}00`,
    `0x${"00".repeat(32)}${original.signature.slice(66)}`,
  ] as Hex[]) {
    await expect(verifyRecipientInfo(context, { ...original, signature }, account.address)).rejects.toMatchObject({ code: "SIGNATURE_REJECTED" });
  }
});

it("constructs the independently fixed RecipientInfo digest for signing", () => {
  expect(hashTypedData(recipientInfoTypedData(context, recipient(), recipientVector.input.owner))).toBe(recipientVector.expected.digest);
});
