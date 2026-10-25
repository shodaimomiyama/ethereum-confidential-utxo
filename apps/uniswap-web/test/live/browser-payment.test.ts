import { expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildOperation, type Context, type OwnedUtxo } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, PreparedPay, Scope } from '@confidential-utxo/uniswap';
import { createBrowserPaymentBinding, type BrowserPaymentDependencies } from '../../src/live/browser-payment.js';
import type { PreparationDecision, PreparationDeployment } from '../../src/live/payment-preparation.js';

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const account = privateKeyToAccount(hash('1'));
const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
const deployment: PreparationDeployment = { chainId: 31337n, pool: address('2'), adapter: address('3'),
  token: address('4'), router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
const coreContext: Context = { chainId: deployment.chainId, pool: deployment.pool, verifier: deployment.pool,
  parametersHash: hash('9'), deploymentBlock: 0n, finalityMode: 'local-simulated' };
const verified = { context: coreContext, manifest: { chainId: 31337, pool: { address: deployment.pool } } } as unknown as VerifiedDeployment;
const opening = { amount: 10n, blinding: 2n };
const coin: OwnedUtxo = { id: hash('d'), owner: scope.owner, opening, commitment: commit(opening),
  checkpoint: { number: 1n, hash: hash('a'), mode: 'local-simulated' }, status: 'available',
  chainId: deployment.chainId, pool: deployment.pool };

async function fixture(terms: { minAmountOut: bigint; deadline: bigint } = { minAmountOut: 99n, deadline: 1_600n }): Promise<BrowserPaymentDependencies> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const rpc = { mode: 'local-simulated', policy: { chunkBlocks: 2_000n, minChunkBlocks: 1n,
    retries: 0, requestTimeoutMs: 1_000, overallTimeoutMs: 3_000 }, client: {
    getChainId: async () => 31337,
    getBlock: async () => ({ number: 12n, hash: hash('a'), timestamp: 1_000n }),
    readContract: async () => [9n, 100n],
  } } as unknown as RpcConnection;
  const context = { scope, epoch: 1, check: () => {}, recordKey: () => key,
    recipientInfo: () => ({ chainId: 31337n, pool: deployment.pool, owner: scope.owner,
      receivePublicKey: hash('c'), receiptFormat: 1 as const, recipientInfoVersion: 1 as const }),
    recipientPrivateKeyForWorker: () => { throw new Error('unused'); },
    typedSign: async (data: Parameters<typeof account.signTypedData>[0]) => ({ scope, epoch: 1,
      value: await account.signTypedData(data) }),
    sendTransaction: async () => { throw new Error('unused'); },
    runCrypto: async (job: { jobId: string; payload: { intent: Parameters<typeof buildOperation>[0]; context: Context; inputs: OwnedUtxo[] } }) => ({
      kind: 'result' as const, jobKind: 'build-operation' as const, scope, epoch: 1, jobId: job.jobId,
      value: await buildOperation(job.payload.intent, job.payload.context,
        { inputs: job.payload.inputs, randomSalt: () => new Uint8Array(32).fill(4) }),
    }),
  } as unknown as BrowserPaymentDependencies['context'];
  return {
    context, rpc, verified, deployment,
    browser: { deploymentId: scope.deploymentId, chainId: 31337n, pool: deployment.pool,
      adapter: deployment.adapter, origin: 'https://local.invalid', siweUri: 'https://local.invalid/app' },
    resolveVerified: () => verified, resolveDeployment: () => deployment,
    inputs: () => [coin], clock: { now: () => 100 },
    currentDecision: (prepared, draft) => prepared.record.kind === 'pay' ? {
      kind: 'pay', identity: { scope, recordId: prepared.record.recordId, contentHash: prepared.record.contentHash },
      deployment, quote: (prepared as PreparedPay).quote,
      terms: { operationId: draft.operationId as never, owner: scope.owner, ethAmount: 9n,
        token: deployment.token, minAmountOut: terms.minAmountOut, recipient: scope.owner, deadline: terms.deadline },
    } : { kind: 'withdraw', identity: { scope, recordId: prepared.record.recordId,
      contentHash: prepared.record.contentHash }, deployment } as PreparationDecision,
    refreshDecision: async () => { throw new Error('unused'); },
    recovery: { readEvidence: async () => { throw new Error('unused'); },
      restoreOriginal: async () => { throw new Error('unused'); },
      restoreForRetry: async () => { throw new Error('unused'); },
      releaseOriginal: async () => { throw new Error('unused'); } },
    reconciliation: { expectedChainId: 31337n, readFinalized: async () => { throw new Error('unused'); } },
  };
}

it('binds a UI payment to the verified quote, signed self change, and Worker draft', async () => {
  const binding = createBrowserPaymentBinding(await fixture());
  const prepared = await binding.client.preparePay({ amount: '0.000000000000000009', recipient: scope.owner });
  expect(prepared.record.kind).toBe('pay');
  expect(prepared.quote.quoteOut).toBe(100n);
  expect(binding.terms(prepared)).toEqual({ minAmountOut: 99n, deadline: 1_600n });
  expect(prepared.record.scope).toEqual(scope);
});

it('uses the saved exact payment decision when no decision callbacks are injected', async () => {
  const deps = await fixture();
  const binding = createBrowserPaymentBinding({ ...deps, currentDecision: undefined, refreshDecision: undefined });
  const prepared = await binding.client.preparePay({ amount: '0.000000000000000009', recipient: scope.owner });
  expect(binding.terms(prepared)).toEqual({ minAmountOut: 99n, deadline: 1_600n });
}, 15_000);

it('rejects an unmatched deployment before creating a payment client', async () => {
  const deps = await fixture();
  expect(() => createBrowserPaymentBinding({ ...deps,
    deployment: { ...deployment, adapter: address('f') } })).toThrow('INVALID_PAYMENT_DEPLOYMENT');
});

it('rejects invalid payment amount before asking the wallet for a secret recipient signature', async () => {
  const deps = await fixture();
  const typedSign = vi.fn(deps.context.typedSign);
  const binding = createBrowserPaymentBinding({ ...deps, context: { ...deps.context, typedSign } });
  await expect(binding.client.preparePay({ amount: '9e-18', recipient: scope.owner })).rejects.toThrow();
  expect(typedSign).not.toHaveBeenCalled();
});

it('binds an edited minimum and absolute deadline into the authorized content hash', async () => {
  const standard = createBrowserPaymentBinding(await fixture());
  const original = await standard.client.preparePay({ amount: '0.000000000000000009', recipient: scope.owner });
  const edited = createBrowserPaymentBinding(await fixture({ minAmountOut: 150n, deadline: 2_000n }));
  const prepared = await edited.client.preparePay({ amount: '0.000000000000000009', recipient: scope.owner,
    minAmountOut: '0.000000000000000150', deadline: '2000' });
  expect(edited.terms(prepared)).toEqual({ minAmountOut: 150n, deadline: 2_000n });
  expect(prepared.record.contentHash).not.toBe(original.record.contentHash);
}, 15_000);

it('rejects an edited deadline at the latest chain time before requesting a signature', async () => {
  const deps = await fixture();
  const typedSign = vi.fn(deps.context.typedSign);
  const binding = createBrowserPaymentBinding({ ...deps, context: { ...deps.context, typedSign } });
  await expect(binding.client.preparePay({ amount: '0.000000000000000009', recipient: scope.owner,
    deadline: '1000' })).rejects.toThrow('INVALID_PAYMENT_TERMS');
  expect(typedSign).not.toHaveBeenCalled();
});
