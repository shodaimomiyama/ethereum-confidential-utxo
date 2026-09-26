import type { Scope } from '@confidential-utxo/uniswap';
import type { generateRangeProof, generateBalanceProof, decryptReceipt } from '@confidential-utxo/crypto';

// This primitive adapter uses core's exact inputs. Task 8 binds the published #29
// operation builder here; operation encoding and authorization stay in core.
export interface CryptoPayloads {
  prove: { readonly range: Parameters<typeof generateRangeProof>; readonly balance: Parameters<typeof generateBalanceProof>[0] };
  receive: Parameters<typeof decryptReceipt>[0];
}
export interface CryptoValues {
  prove: { readonly range: ReturnType<typeof generateRangeProof>; readonly balance: ReturnType<typeof generateBalanceProof> };
  receive: Awaited<ReturnType<typeof decryptReceipt>>;
}
export interface JobIdentity { readonly jobId: string; readonly epoch: number; readonly scope: Scope }
export type CryptoJob = { [K in keyof CryptoPayloads]: JobIdentity & { readonly kind: K; readonly payload: CryptoPayloads[K] } }[keyof CryptoPayloads];
export type CryptoResult = { [K in keyof CryptoValues]: JobIdentity & { readonly kind: 'result'; readonly jobKind: K; readonly value: CryptoValues[K] } }[keyof CryptoValues];
export type CryptoReply = CryptoResult | (JobIdentity & { readonly kind: 'error'; readonly jobKind: CryptoJob['kind']; readonly code: 'CRYPTO_FAILED' });
