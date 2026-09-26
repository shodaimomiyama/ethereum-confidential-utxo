import { expect, it } from "vitest";
import { createWalletClient, custom, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { authorizationTypedData, recipientInfoTypedData, verifyOperationAuthorization, verifyRecipientInfo } from "@confidential-utxo/core";
import type { OperationRequest, RecipientInfo } from "@confidential-utxo/core";
import { createOperationSigner, createRecipientInfoSigner } from "../src/signing.js";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const context = { chainId: 31337n, pool: "0x1111111111111111111111111111111111111111" as Address };
const request: OperationRequest = { kind: 2, owner: account.address, salt: `0x${"11".repeat(32)}`,
  inputIds: [`0x${"22".repeat(32)}`], outputs: [], d: 0n, w: 1n, destination: account.address };
const recipient: Omit<RecipientInfo, "signature"> = { ...context, owner: account.address,
  receivePublicKey: `0x${"33".repeat(32)}`, receiptFormat: 1, recipientInfoVersion: 1 };

it("signs both core typed-data forms with a local account", async () => {
  const operation = authorizationTypedData(context, request);
  const operationSignature = await createOperationSigner(account, account.address).signTypedData(operation);
  await expect(verifyOperationAuthorization(context, operation.message.operationId, account.address, operationSignature)).resolves.toBeUndefined();
  const info = recipientInfoTypedData(context, recipient, account.address);
  const recipientSignature = await createRecipientInfoSigner(account, account.address).signTypedData(info);
  await expect(verifyRecipientInfo(context, { ...recipient, signature: recipientSignature }, account.address)).resolves.toBeUndefined();
});

it("uses a wallet client with a separately selected account", async () => {
  const wallet = createWalletClient({ account, transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_accounts") return [account.address];
    throw new Error(`unexpected ${method}`);
  } }) });
  const typed = authorizationTypedData(context, request);
  const signature = await createOperationSigner(wallet, account.address).signTypedData(typed);
  await expect(verifyOperationAuthorization(context, typed.message.operationId, account.address, signature)).resolves.toBeUndefined();
});

it("rejects a different selected owner and wrong wallet chain", async () => {
  const typed = authorizationTypedData(context, request);
  await expect(createOperationSigner(account, zeroAddress).signTypedData(typed))
    .rejects.toMatchObject({ code: "INCONSISTENT" });
  const wallet = createWalletClient({ account, transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_accounts") return [account.address];
    throw new Error(`unexpected ${method}`);
  } }) });
  await expect(createOperationSigner(wallet, account.address).signTypedData(typed))
    .rejects.toMatchObject({ code: "INCONSISTENT" });
});

it("rejects a wallet that switches chain after signing or returns another account's signature", async () => {
  let chainReads = 0;
  const switched = createWalletClient({ transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return ++chainReads === 1 ? "0x7a69" : "0x1";
    if (method === "eth_accounts") return [account.address];
    if (method === "eth_signTypedData_v4") return "0x";
    throw new Error(`unexpected ${method}`);
  } }) });
  await expect(createOperationSigner(switched, account.address)
    .signTypedData(authorizationTypedData(context, request)))
    .rejects.toMatchObject({ code: "INCONSISTENT" });
  const another = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const wrongSignature = createWalletClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_accounts") return [account.address];
    if (method === "eth_signTypedData_v4") return another.signTypedData(JSON.parse((params as string[])[1]!));
    throw new Error(`unexpected ${method}`);
  } }) });
  await expect(createOperationSigner(wrongSignature, account.address)
    .signTypedData(authorizationTypedData(context, request)))
    .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
});

it.each([
  { code: 4001, expected: "SIGNATURE_REJECTED" },
  { code: 4200, expected: "UNSUPPORTED" },
  { code: -32603, expected: "RPC" },
])("classifies provider code $code without leaking credentials", async ({ code, expected }) => {
  const wallet = createWalletClient({ transport: custom({ request: async ({ method }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_accounts") return [account.address];
    if (method === "eth_signTypedData_v4") throw Object.assign(new Error("https://rpc.invalid/SECRET_TOKEN"), { code });
    throw new Error(`unexpected ${method}`);
  } }) });
  try {
    await createOperationSigner(wallet, account.address).signTypedData(authorizationTypedData(context, request));
    throw new Error("signature should fail");
  } catch (error) {
    expect(error).toMatchObject({ code: expected });
    expect(String(error)).not.toContain("SECRET_TOKEN");
  }
});
