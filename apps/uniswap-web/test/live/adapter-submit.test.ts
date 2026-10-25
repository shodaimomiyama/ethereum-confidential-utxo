import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizationTypedData, buildOperation, recipientInfoTypedData, type Context } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import { uniswapPayAbi, type RpcConnection } from '@confidential-utxo/ethereum';
import { paymentAuthorizationTypedData, paymentDigest,
  type Address, type PaymentPorts, type PaymentTerms, type PreparedPay, type Scope } from '@confidential-utxo/uniswap';
import { createAdapterSubmit } from '../../src/live/adapter-submit.js';
import { encodePaymentPrivateRecord } from '../../src/live/payment-record.js';
import type { OperationContext } from '../../src/live/operations.js';

vi.setConfig({ testTimeout: 30_000 });

const id = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const account = privateKeyToAccount(id('1'));
const scope = { deploymentId: 'local', owner: account.address } as Scope;
const deployment = { chainId: 31337n, pool: `0x${'22'.repeat(20)}` as Address,
  adapter: `0x${'33'.repeat(20)}` as Address };

async function prepareFixture() {
  const coreContext: Context = { chainId: deployment.chainId, pool: deployment.pool,
    verifier: deployment.pool, parametersHash: id('1'), deploymentBlock: 0n, finalityMode: 'finalized' };
  const opening = { amount: 10n, blinding: 2n };
  const unsigned = { chainId: deployment.chainId, pool: deployment.pool, owner: account.address,
    receivePublicKey: id('7'), receiptFormat: 1, recipientInfoVersion: 1 } as const;
  const recipient = { ...unsigned, signature: await account.signTypedData(recipientInfoTypedData(coreContext, unsigned, account.address)) };
  const draft = await buildOperation({ kind: 2, owner: account.address, amount: 9n,
    destination: deployment.adapter, changeRecipient: recipient }, coreContext,
    { randomSalt: () => new Uint8Array(32).fill(4), inputs: [{ id: id('2'), owner: account.address, opening,
      commitment: commit(opening), checkpoint: { number: 1n, hash: id('3'), mode: 'finalized' },
      status: 'available', chainId: deployment.chainId, pool: deployment.pool }] });
  const terms: PaymentTerms = { operationId: draft.operationId as never, owner: scope.owner, ethAmount: 9n,
    token: `0x${'44'.repeat(20)}` as Address, minAmountOut: 1n,
    recipient: `0x${'55'.repeat(20)}` as Address, deadline: 600n };
  const record = { kind: 'pay', paymentId: paymentDigest(terms, deployment.chainId, deployment.adapter),
    deadline: terms.deadline, scope, recordId: id('4'), inputId: id('2'), operationId: draft.operationId,
    contentHash: id('5'), encryptedBundle: { nonce: '', ciphertext: '', tag: '' },
    signatureStarted: true, attemptIds: [] } as unknown as PreparedPay['record'];
  const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = record;
  const poolAuthorization = authorizationTypedData(coreContext, draft.request);
  const prepared: PreparedPay = { record, poolAuthorization,
    quote: { startedAtMs: 0, blockHash: id('1') as never, blockNumber: 1n, inputWei: 9n, quoteOut: 99n },
    privateBytes: encodePaymentPrivateRecord({ version: 1, creationInputs: draft, binding,
      operationId: record.operationId, paymentId: record.paymentId,
      intendedAuthorization: { pool: poolAuthorization,
        payment: paymentAuthorizationTypedData(terms, deployment.chainId, deployment.adapter) },
      attempts: [], recoveryMarkers: {} }) };
  const signatures = { pool: await account.signTypedData(poolAuthorization),
    payment: await account.signTypedData(paymentAuthorizationTypedData(terms, deployment.chainId, deployment.adapter)) };
  return { prepared, signatures, terms };
}
let sharedPreparation: ReturnType<typeof prepareFixture> | undefined;
async function fixture() {
  const { prepared, signatures, terms } = await (sharedPreparation ??= prepareFixture());
  let epoch = 0;
  const sent = vi.fn(async (_request: unknown) => ({ scope, epoch: 0, value: id('a') }));
  const context = { scope, epoch: 0, check: () => { if (epoch) throw new Error('SCOPE_CHANGED'); },
    sendTransaction: sent } as unknown as OperationContext;
  const rpc = { client: { getChainId: vi.fn(async () => 31337), estimateGas: vi.fn(async () => 100_000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 7), getBalance: vi.fn(async () => 1_000_000n) } } as unknown as RpcConnection;
  let current = deployment;
  const submit = createAdapterSubmit({ context, rpc, resolveDeployment: () => current,
    paymentTerms: () => terms });
  return { prepared, signatures, submit, sent, rpc, terms,
    drift: () => { epoch++; }, changeDeployment: () => { current = { ...deployment, adapter: account.address as Address }; } };
}

it('uses the pay entry from the verified compiler artifact', () => {
  const record = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-payment-v1.json', 'utf8')) as
    { abi: readonly { type: string; name?: string }[] };
  expect(uniswapPayAbi).toEqual(record.abi.filter(item => item.type === 'function' && item.name === 'pay'));
});

it('encodes the generated pay ABI with fixed terms and sends zero ETH only to the adapter', async () => {
  const f = await fixture();
  expect(await f.submit(f.prepared, f.signatures, 'attempt-1' as never))
    .toEqual({ kind: 'submitted', txHash: id('a') });
  const tx = f.sent.mock.calls[0]![0] as Record<string, unknown>;
  expect(tx.to).toBe(deployment.adapter);
  expect(tx.value).toBe('0x0');
  expect(tx.from).toBe(account.address);
  expect(tx.nonce).toBe('0x7');
  const call = decodeFunctionData({ abi: uniswapPayAbi, data: tx.data as `0x${string}` });
  expect(call.functionName).toBe('pay');
  expect(call.args?.[0]).toMatchObject({ kind: 2, destination: deployment.adapter, w: 9n });
  expect(call.args?.[3]).toBe(f.signatures.pool);
  expect(call.args?.[4]).toEqual(f.terms);
  expect(call.args?.[5]).toBe(f.signatures.payment);
  expect(JSON.stringify(tx)).not.toContain('openings');
});

it('refuses invalid binding and gas quote before wallet invocation', async () => {
  const f = await fixture();
  const wrong = { ...f.prepared, record: { ...f.prepared.record, paymentId: id('f') } } as PreparedPay;
  expect(await f.submit(wrong, f.signatures, 'attempt-1' as never)).toEqual({ kind: 'not-submitted' });
  expect(f.sent).not.toHaveBeenCalled();
  vi.mocked(f.rpc.client.estimateGas).mockRejectedValueOnce(new Error('estimate failed'));
  expect(await f.submit(f.prepared, f.signatures, 'attempt-1' as never)).toEqual({ kind: 'not-submitted' });
  expect(f.sent).not.toHaveBeenCalled();
});

it('keeps lost wallet response and epoch drift unknown', async () => {
  const f = await fixture();
  f.sent.mockRejectedValueOnce(new Error('response lost'));
  expect(await f.submit(f.prepared, f.signatures, 'attempt-1' as never)).toEqual({ kind: 'unknown' });
  const g = await fixture();
  g.sent.mockImplementationOnce(async () => { g.drift(); return { scope, epoch: 0, value: id('a') }; });
  expect(await g.submit(g.prepared, g.signatures, 'attempt-1' as never)).toEqual({ kind: 'unknown' });
});

it('rejects a response with an invalid hash after wallet invocation', async () => {
  const f = await fixture();
  f.sent.mockResolvedValueOnce({ scope, epoch: 0, value: '0x01' });
  expect(await f.submit(f.prepared, f.signatures, 'attempt-1' as never)).toEqual({ kind: 'unknown' });
});

it('treats scope drift before wallet invocation as unknown', async () => {
  const f = await fixture();
  f.changeDeployment();
  expect(await f.submit(f.prepared, f.signatures, 'attempt-1' as never)).toEqual({ kind: 'unknown' });
  expect(f.sent).not.toHaveBeenCalled();
});
