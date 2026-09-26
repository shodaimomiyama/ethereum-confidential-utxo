import { expect, it } from 'vitest';
import type { OperationId, OperationRef, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { mapDecisionToView } from '../../src/live/index.js';

const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
const operationId = `0x${'33'.repeat(32)}` as OperationId;
const previous = { scope, operations: [], operationCards: {}, cards: { pay: { phase: 'pending', input: { amount: '1' } } } } as unknown as ViewState;
it.each(['pending', 'invalid', 'confirmed'] as const)('preserves finalized success with receipt %s', receiptState => {
  const operation: OperationRef = { scope, operationId, attemptIds: [], txHashes: [], chainOutcome: 'finalized-success', receiptState };
  const result = mapDecisionToView(previous, { scope, operation, card: 'pay', view: previous });
  expect(result.operations[0]?.chainOutcome).toBe('finalized-success');
  expect(result.cards.pay.phase).toBe(receiptState === 'invalid' ? 'receipt-invalid' : receiptState === 'pending' ? 'confirmed-receipt-pending' : 'complete');
});
it('uses the published decision for balances, actions and selections unchanged', () => {
  const decision = { ...previous, availablePrivateWei: 4n, pendingPrivateWei: 9n, allowedActions: ['resync'], selectedInput: {}, utxos: [] };
  expect(mapDecisionToView(previous, { scope, view: decision })).toEqual(decision);
});
it('rejects an operation or view from another scope', () => {
  const other = { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope;
  expect(() => mapDecisionToView(previous, { scope: other, view: previous })).toThrow('SCOPE_CHANGED');
  expect(() => mapDecisionToView(previous, { scope, view: { ...previous, scope: other } })).toThrow('SCOPE_CHANGED');
});
