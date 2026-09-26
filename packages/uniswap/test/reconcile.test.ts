import { expect, it } from 'vitest';
import { reconcilePayment } from '../src/reconcile.js';
import type { FinalizedHistory } from '../src/reconcile.js';
import type { OperationRef, Scope } from '../src/domain.js';
import { parseOperationRecord } from '../src/api.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const op = `0x${'22'.repeat(32)}`;
const payment = `0x${'33'.repeat(32)}`;
const input = `0x${'44'.repeat(32)}`;
const change = `0x${'55'.repeat(32)}`;
const block = `0x${'66'.repeat(32)}`;
const otherBlock = `0x${'77'.repeat(32)}`;
const ref: OperationRef = {
  scope, operationId: op as never, paymentId: payment as never,
  attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'pending',
};
const record = parseOperationRecord({
  kind: 'pay', recordId: op, inputId: input, operationId: op, paymentId: payment,
  contentHash: op, encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
  deadline: '600', signatureStarted: true, attemptIds: [],
}, scope);
const history = (): FinalizedHistory => ({
  chainId: 31337n, deploymentId: scope.deploymentId,
  blockHash: block as never, finalized: true, canonical: true, rpcConsistent: true,
  adapter: { blockHash: block as never, paymentId: payment as never, operationId: op as never, owner: scope.owner, amountOut: 99n },
  pool: { blockHash: block as never, operationId: op as never, inputId: input as never, changeOutputId: change as never },
  input: { blockHash: block as never, inputId: input as never, consumed: true },
  change: { blockHash: block as never, outputId: change as never, owner: scope.owner },
});
const receipt = (currentlyUnspent = true) => ({ state: 'confirmed' as const, outputId: change as never, currentlyUnspent });

it('confirms a payment only when Adapter, Pool, input and change match one finalized block', () => {
  const result = reconcilePayment(ref, record, history(), receipt(), 31337n);
  expect(result.operation.chainOutcome).toBe('finalized-success');
  expect(result.operation.receiptState).toBe('confirmed');
  expect(result.changeUsable).toBe(true);
});

it('does not treat an Adapter event alone, another block, or wrong change as success', () => {
  expect(reconcilePayment(ref, record, { ...history(), pool: undefined }, receipt(), 31337n).operation.chainOutcome).toBe('unknown');
  expect(reconcilePayment(ref, record, { ...history(), pool: { ...history().pool!, blockHash: otherBlock as never } }, receipt(), 31337n).operation.chainOutcome).toBe('unknown');
  expect(reconcilePayment(ref, record, { ...history(), change: { ...history().change!, outputId: input as never } }, receipt(), 31337n).operation.chainOutcome).toBe('unknown');
});

it('finds another sender’s success without a known transaction hash', () => {
  expect(ref.txHashes).toEqual([]);
  expect(reconcilePayment(ref, record, history(), receipt(), 31337n).operation.chainOutcome).toBe('finalized-success');
});

it('drops certainty on a reorg, RPC disagreement, or wrong deployment', () => {
  for (const variant of [
    { ...history(), canonical: false },
    { ...history(), rpcConsistent: false },
    { ...history(), deploymentId: 'other' as never },
    { ...history(), chainId: 1n },
  ]) {
    const result = reconcilePayment(ref, record, variant, receipt(), 31337n);
    expect(result.operation.chainOutcome).toBe('unknown');
    expect(result.changeUsable).toBe(false);
  }
});

it('keeps chain success separate from invalid receipt and later-spent change', () => {
  expect(reconcilePayment(ref, record, history(), { state: 'invalid', outputId: change as never, currentlyUnspent: true }, 31337n).operation).toMatchObject({
    chainOutcome: 'finalized-success', receiptState: 'invalid',
  });
  const spentLater = reconcilePayment(ref, record, history(), receipt(false), 31337n);
  expect(spentLater.operation.chainOutcome).toBe('finalized-success');
  expect(spentLater.changeUsable).toBe(false);
});
