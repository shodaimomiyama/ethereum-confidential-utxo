import type { Address, Hex, WalletClient } from "viem";
import type { LocalAccount } from "viem/accounts";
import { verifyOperationAuthorization, verifyRecipientInfo } from "@confidential-utxo/core";
import { CoreFailure } from "@confidential-utxo/core";
import type { OperationAuthorizationTypedData, RecipientInfoSignerPort, RecipientInfoTypedData, SignerPort } from "@confidential-utxo/core";

export type SigningSource = LocalAccount | WalletClient;

function providerCode(error: unknown): number | undefined {
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const value = Reflect.get(current, "code");
    if (typeof value === "number") return value;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

function signerFailure(error: unknown): never {
  if (error instanceof CoreFailure) throw error;
  const code = providerCode(error);
  if (code === 4001) throw new CoreFailure("SIGNATURE_REJECTED", "signer.wallet");
  if (code === 4200 || code === -32601) throw new CoreFailure("UNSUPPORTED", "signer.wallet");
  throw new CoreFailure("RPC", "signer.wallet");
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function sign(source: SigningSource, account: Address,
  data: OperationAuthorizationTypedData | RecipientInfoTypedData): Promise<Hex> {
  if (!sameAddress(account, data.message.owner)) throw new CoreFailure("INCONSISTENT", "signer.owner");
  try {
    if (!("getChainId" in source)) {
      const local = source as LocalAccount;
      if (!sameAddress(local.address, account)) throw new CoreFailure("INCONSISTENT", "signer.account");
      return await local.signTypedData(data as Parameters<LocalAccount["signTypedData"]>[0]);
    }
    const wallet = source as WalletClient;
    const chain = await wallet.getChainId();
    if (BigInt(chain) !== data.domain.chainId) throw new CoreFailure("INCONSISTENT", "signer.chain");
    const addresses = await wallet.getAddresses();
    if (!addresses.some(value => sameAddress(value, account))) throw new CoreFailure("INCONSISTENT", "signer.account");
    const walletAccount = wallet.account?.type === "local" && sameAddress(wallet.account.address, account)
      ? wallet.account : account;
    const signature = await wallet.signTypedData({ account: walletAccount, ...data } as Parameters<WalletClient["signTypedData"]>[0]);
    if (BigInt(await wallet.getChainId()) !== data.domain.chainId) throw new CoreFailure("INCONSISTENT", "signer.chain");
    return signature;
  } catch (error) {
    signerFailure(error);
  }
}

export function createOperationSigner(source: SigningSource, account: Address): SignerPort {
  return { signTypedData: async data => {
    const signature = await sign(source, account, data);
    try {
      await verifyOperationAuthorization({ chainId: data.domain.chainId, pool: data.domain.verifyingContract },
        data.message.operationId, data.message.owner, signature);
    } catch {
      throw new CoreFailure("SIGNATURE_INVALID", "signer.signature");
    }
    return signature;
  } };
}

export function createRecipientInfoSigner(source: SigningSource, account: Address): RecipientInfoSignerPort {
  return { signTypedData: async data => {
    const signature = await sign(source, account, data);
    try {
      await verifyRecipientInfo({ chainId: data.domain.chainId, pool: data.domain.verifyingContract },
        { ...data.message, chainId: data.domain.chainId, pool: data.domain.verifyingContract, signature }, account);
    } catch {
      throw new CoreFailure("SIGNATURE_INVALID", "signer.signature");
    }
    return signature;
  } };
}
