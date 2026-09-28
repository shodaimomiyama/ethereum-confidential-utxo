import { expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildOperation, recipientInfoTypedData, type Context, type LocalDraft } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import { appendPaymentAuthorization, decodePaymentPrivateRecord } from '../../src/live/payment-record.js';
import { buildPreparedPayment, preparePaymentWithWorker, validatePreparedPayment,
  paymentContentHash, type PreparationDecision, type PreparationDeployment } from '../../src/live/payment-preparation.js';
import type { OperationContext } from '../../src/live/operations.js';

const hash = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const wallet = privateKeyToAccount(hash('1'));
const scope = { deploymentId: 'local', owner: wallet.address } as Scope;
const deployment: PreparationDeployment = { chainId: 31337n, pool: `0x${'22'.repeat(20)}` as Address,
  adapter: `0x${'33'.repeat(20)}` as Address, token: `0x${'44'.repeat(20)}` as Address,
  router: `0x${'55'.repeat(20)}` as Address, factory: `0x${'66'.repeat(20)}` as Address,
  weth: `0x${'77'.repeat(20)}` as Address, pair: `0x${'88'.repeat(20)}` as Address };
const coreContext: Context = { chainId: deployment.chainId, pool: deployment.pool, verifier: deployment.pool,
  parametersHash: hash('9'), deploymentBlock: 0n, finalityMode: 'finalized' };
const identity = { scope, recordId: hash('a') as never, contentHash: hash('b') as never };
async function fixture(kind: 'pay' | 'withdraw') {
  const opening = { amount: 10n, blinding: 2n };
  const unsigned = { chainId: deployment.chainId, pool: deployment.pool, owner: wallet.address,
    receivePublicKey: hash('c'), receiptFormat: 1, recipientInfoVersion: 1 } as const;
  const recipient = { ...unsigned, signature: await wallet.signTypedData(recipientInfoTypedData(coreContext, unsigned, wallet.address)) };
  const draft = await buildOperation({ kind: 2, owner: wallet.address, amount: kind === 'pay' ? 9n : 10n,
    destination: kind === 'pay' ? deployment.adapter : wallet.address,
    ...(kind === 'pay' ? { changeRecipient: recipient } : {}) }, coreContext,
  { randomSalt: () => new Uint8Array(32).fill(4), inputs: [{ id: hash('d'), owner: wallet.address, opening,
    commitment: commit(opening), checkpoint: { number: 1n, hash: hash('e'), mode: 'finalized' },
    status: 'available', chainId: deployment.chainId, pool: deployment.pool }] });
  const decision: PreparationDecision = kind === 'pay'
    ? { kind, identity, deployment, terms: { operationId: draft.operationId as never, owner: scope.owner,
      ethAmount: 9n, token: deployment.token, minAmountOut: 99n, recipient: scope.owner, deadline: 600n },
      quote: { startedAtMs: 10, blockHash: hash('e') as never, blockNumber: 1n, inputWei: 9n, quoteOut: 100n } }
    : { kind, identity, deployment };
  if (decision.kind === 'pay') return { draft, decision: { ...decision, identity: { ...identity,
    contentHash: paymentContentHash(draft, decision.terms, decision.quote, deployment) } } as PreparationDecision };
  return { draft, decision };
}
it.each(['pay', 'withdraw'] as const)('builds and validates exact %s binding from a real core draft', async kind => {
  const { draft, decision } = await fixture(kind);
  const prepared = buildPreparedPayment(draft, decision);
  expect(() => validatePreparedPayment(prepared, decision)).not.toThrow();
  const plain = decodePaymentPrivateRecord(prepared.privateBytes);
  if (kind === 'pay' && 'quote' in prepared) expect(plain.quote).toEqual(prepared.quote);
  expect(plain.creationInputs.operationId).toBe(draft.operationId);
  expect(plain.binding.inputId).toBe(hash('d'));
  expect(plain.signatures).toBeUndefined();
  expect(prepared.record.signatureStarted).toBe(false);
  expect(prepared.record.attemptIds).toEqual([]);
  expect(Object.keys(prepared.record)).not.toContain('blinding');
  expect(() => validatePreparedPayment({ ...prepared, record: { ...prepared.record, contentHash: hash('f') as never } } as typeof prepared, decision)).toThrow();
});
it('rejects changed payment terms and an invalid full withdrawal', async () => {
  const pay = await fixture('pay');
  const prepared = buildPreparedPayment(pay.draft, pay.decision);
  const decision = pay.decision;
  if (decision.kind !== 'pay') throw new Error('fixture');
  expect(() => validatePreparedPayment(prepared, { ...decision, terms: { ...decision.terms, minAmountOut: 1n } })).toThrow();
  const withdraw = await fixture('withdraw');
  expect(() => buildPreparedPayment({ ...withdraw.draft,
    request: { ...withdraw.draft.request, destination: deployment.adapter } } as LocalDraft, withdraw.decision)).toThrow();
});
it('accepts only the current scoped Worker reply', async () => {
  const { draft, decision } = await fixture('withdraw');
  let current = true;
  const context = { scope, epoch: 3, check: () => { if (!current) throw new Error('SCOPE_CHANGED'); },
    runCrypto: async () => ({ kind: 'result', jobKind: 'build-operation', epoch: 3, scope, jobId: 'draft-1', value: draft }) } as unknown as OperationContext;
  const payload = { intent: { kind: 2 as const, owner: wallet.address, amount: 10n, destination: wallet.address },
    context: coreContext, inputs: [] };
  const prepared = await preparePaymentWithWorker(context, payload, () => decision, 'draft-1');
  expect(() => validatePreparedPayment(prepared, decision)).not.toThrow();
  current = false;
  await expect(preparePaymentWithWorker(context, payload, () => decision, 'draft-2')).rejects.toThrow('SCOPE_CHANGED');
  const stale = { ...context, check: () => {}, runCrypto: async () => ({ kind: 'result', jobKind: 'build-operation', epoch: 2,
    scope, jobId: 'draft-3', value: draft }) } as unknown as OperationContext;
  await expect(preparePaymentWithWorker(stale, payload, () => decision, 'draft-3')).rejects.toThrow('INVALID_PAYMENT_PREPARATION');
});
it('exposes #55 preparation methods with injected decisions', async () => {
  const { draft, decision } = await fixture('pay');
  if (decision.kind !== 'pay') throw new Error('fixture');
  const context = { scope, epoch: 1, check: () => {},
    runCrypto: async (job: { jobId: string }) => ({ kind: 'result', jobKind: 'build-operation',
      epoch: 1, scope, jobId: job.jobId, value: draft }) } as unknown as OperationContext;
  const { createPaymentPreparationPorts } = await import('../../src/live/payment-preparation.js');
  const ports = createPaymentPreparationPorts({ context, jobId: () => 'job',
    payPlan: async () => ({ payload: { intent: { kind: 2, owner: wallet.address, amount: 9n, destination: deployment.adapter },
      context: coreContext, inputs: [] }, decide: () => decision }),
    withdrawPlan: async () => { throw new Error('unused'); },
    refreshDecision: async () => decision,
    currentDecision: () => decision });
  const prepared = await ports.preparePay({});
  await ports.validatePrepared(prepared);
  expect(ports.paymentTerms(prepared)).toEqual(decision.terms);
  const refreshed = await ports.refreshPay(prepared);
  expect(refreshed.record.operationId).toBe(prepared.record.operationId);
  expect(refreshed.record.paymentId).toBe(prepared.record.paymentId);
});

it('validates a restored signed revision and rejects mismatched attempt history', async () => {
  const { draft, decision } = await fixture('pay');
  const fresh = buildPreparedPayment(draft, decision);
  const signatures = { pool: `0x${'11'.repeat(65)}` as `0x${string}`,
    payment: `0x${'22'.repeat(65)}` as `0x${string}` };
  const bytes = appendPaymentAuthorization(fresh.privateBytes, signatures, 'attempt-1' as never, hash('f') as never);
  const restored = { ...fresh, privateBytes: bytes, record: { ...fresh.record, signatureStarted: true,
    attemptIds: ['attempt-1' as never] } } as typeof fresh;
  expect(() => validatePreparedPayment(restored, decision)).not.toThrow();
  expect(() => validatePreparedPayment({ ...restored, record: { ...restored.record,
    attemptIds: ['attempt-2' as never] } } as typeof fresh, decision)).toThrow();
  expect(() => validatePreparedPayment({ ...restored, record: { ...restored.record,
    signatureStarted: false } } as typeof fresh, decision)).toThrow();
});
it('rejects a caller supplied payment content hash unrelated to displayed terms', async () => {
  const { draft, decision } = await fixture('pay');
  expect(() => buildPreparedPayment(draft, { ...decision,
    identity: { ...decision.identity, contentHash: hash('f') as never } })).toThrow();
});
it('changes the confirmation hash for every displayed fixed payment term', async () => {
  const { draft, decision } = await fixture('pay');
  if (decision.kind !== 'pay') throw new Error('fixture');
  const original = paymentContentHash(draft, decision.terms, decision.quote, deployment);
  const changed = [
    paymentContentHash(draft, { ...decision.terms, ethAmount: 8n }, decision.quote, deployment),
    paymentContentHash(draft, { ...decision.terms, minAmountOut: 98n }, decision.quote, deployment),
    paymentContentHash(draft, { ...decision.terms, deadline: 601n }, decision.quote, deployment),
    paymentContentHash(draft, decision.terms, { ...decision.quote, quoteOut: 101n }, deployment),
    paymentContentHash(draft, { ...decision.terms, recipient: deployment.token }, decision.quote, deployment),
    paymentContentHash(draft, { ...decision.terms, token: deployment.pair }, decision.quote, deployment),
  ];
  for (const contentHash of changed) expect(contentHash).not.toBe(original);
  expect(paymentContentHash(draft, decision.terms,
    { ...decision.quote, blockHash: hash('f') as never, startedAtMs: 20 }, deployment)).toBe(original);
});
