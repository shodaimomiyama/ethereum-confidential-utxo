import { expect, it } from 'vitest';
import type { OperationId, OperationRef, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { mapDecisionToView } from '../../src/live/index.js';
import { projectConnectionChange, projectDraft, projectScopeChange, projectUnconfirmedSync } from '../../src/live/operations.js';

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

function populated(): ViewState {
  const operation: OperationRef = { scope, operationId, attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'none' };
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [{ id: 'secret-output', amountWei: 5n, available: true }], selectedInput: { pay: { id: 'secret-output', amountWei: 5n, changeWei: 3n } },
    operationCards: { [operationId]: 'pay' }, operationActions: { [operationId]: ['recheck', 'retry-attempt', 'acknowledge-receipt'] },
    publicEthWei: 9n, availablePrivateWei: 5n, pendingPrivateWei: 2n, checkedAt: 123, isStale: false,
    storageAvailability: 'healthy', cards: { reward: { phase: 'ready', input: {} }, pay: { phase: 'ready', input: { amount: '2' },
      quote: { startedAt: 1, quoteOut: 3n, minAmountOut: 2n, deadline: 100n } }, deposit: { phase: 'ready', input: {} }, withdraw: { phase: 'ready', input: {} } },
    operations: [operation], rewardRequests: [{ requestId: 'request' as never, status: 'pending' }],
    allowedActions: ['switch-scope', 'resync', 'edit:pay', 'start:pay', 'retry-attempt', 'acknowledge-receipt'], reasons: {} };
}

it('keeps scoped display stale on rollback while removing spendable decisions', () => {
  const old = populated();
  const next = projectUnconfirmedSync(old, 'rollback');
  expect(next.storageAvailability).toBe('rollback');
  expect(next.isStale).toBe(true);
  expect(next.availablePrivateWei).toBe(5n);
  expect(next.operations[0]).toMatchObject({ operationId, chainOutcome: 'pending' });
  expect(next.utxos).toEqual([{ id: 'secret-output', amountWei: 5n, available: false }]);
  expect(next.selectedInput).toEqual({});
  expect(next.allowedActions).toEqual(['switch-scope', 'resync', 'edit:pay', 'recheck-reward']);
  expect(next.operationActions[operationId]).toEqual(['recheck']);
});

it('uses the prior scoped display when a sync cannot confirm new data', () => {
  const old = populated();
  const unconfirmed = { ...old, isStale: true, storageAvailability: 'rollback' as const,
    publicEthWei: 100n, operations: [], allowedActions: ['start:pay'] };
  const next = mapDecisionToView(old, { scope, view: unconfirmed });
  expect(next.publicEthWei).toBe(9n);
  expect(next.operations[0]).toMatchObject({ operationId, chainOutcome: 'pending' });
  expect(next.isStale).toBe(true);
  expect(next.allowedActions).not.toContain('start:pay');
});

it('retains newly verified same-scope identities for recheck when sync is stale', () => {
  const old = populated();
  const newId = `0x${'55'.repeat(32)}` as OperationId;
  const operation: OperationRef = { scope, operationId: newId, attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'none' };
  const requestId = `0x${'66'.repeat(32)}` as never;
  const unconfirmed: ViewState = { ...old, operations: [operation], operationCards: { [newId]: 'withdraw' },
    rewardRequests: [{ requestId, status: 'pending' }], isStale: true, storageAvailability: 'rollback' };
  const next = mapDecisionToView(old, { scope, view: unconfirmed, operation, card: 'withdraw' });
  expect(next.operations.map(item => item.operationId)).toEqual([operationId, newId]);
  expect(next.operations.find(item => item.operationId === newId)?.chainOutcome).toBe('pending');
  expect(next.operationCards[newId]).toBe('withdraw');
  expect(next.operationActions[newId]).toContain('recheck');
  expect(next.rewardRequests.map(item => item.requestId)).toContain(requestId);
  expect(next.allowedActions).toContain('recheck-reward');
  expect(next.allowedActions).not.toContain('start:pay');
});

it('does not show stale completed operations or received rewards as fresh success', () => {
  const old = populated();
  const completed: ViewState = { ...old,
    operations: [{ ...old.operations[0]!, chainOutcome: 'finalized-success', receiptState: 'confirmed' }],
    rewardRequests: [{ requestId: 'request' as never, status: 'received' }],
    cards: { ...old.cards, pay: { ...old.cards.pay, phase: 'complete' }, reward: { ...old.cards.reward, phase: 'complete' } } };
  const stale = projectUnconfirmedSync(completed, 'rollback');
  expect(stale.operations[0]?.chainOutcome).toBe('unknown');
  expect(stale.rewardRequests[0]?.status).toBe('unknown');
  expect(stale.cards.pay.phase).toBe('unknown');
  expect(stale.cards.reward.phase).toBe('unknown');
  expect(stale.operationActions[operationId]).toEqual(['recheck']);
  const throughDecision = mapDecisionToView(completed, { scope, view: { ...completed, isStale: true, storageAvailability: 'rollback' } });
  expect(throughDecision.operations[0]?.chainOutcome).toBe('unknown');
  expect(throughDecision.rewardRequests[0]?.status).toBe('unknown');
});

it('clears all scoped data when changing scope', () => {
  const other = { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope;
  const next = projectScopeChange(populated(), other);
  expect(next.scope).toEqual(other);
  expect(next.operations).toEqual([]);
  expect(next.rewardRequests).toEqual([]);
  expect(next.utxos).toEqual([]);
  expect(next.availablePrivateWei).toBe(0n);
  expect(next.cards.pay.input).toEqual({});
  expect(next.operationActions).toEqual({});
  expect(next.currentScope).toBeUndefined();
});

it('invalidates spending choices and key readiness on a wallet event', () => {
  const next = projectConnectionChange(populated(), { epoch: 2, scope });
  expect(next.connection).toBe('connected');
  expect(next.currentScope).toEqual(scope);
  expect(next.preparation.key).toBe(false);
  expect(next.allowedActions).not.toContain('start:pay');
  expect(projectConnectionChange(populated(), { epoch: 3 }).currentScope).toBeUndefined();
});

it.each(['disconnect', 'different owner'] as const)('redacts prior owner data on %s', mode => {
  const old = populated();
  const event = mode === 'disconnect' ? { epoch: 3 }
    : { epoch: 3, scope: { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope };
  const next = projectConnectionChange(old, event);
  expect(next.connection).toBe(mode === 'disconnect' ? 'disconnected' : 'connected');
  expect(next.currentScope).toEqual(mode === 'disconnect' ? undefined : event.scope);
  if (mode === 'different owner') expect(next.scope).toEqual(event.scope);
  expect(next.publicEthWei).toBe(0n);
  expect(next.availablePrivateWei).toBe(0n);
  expect(next.pendingPrivateWei).toBe(0n);
  expect(next.utxos).toEqual([]);
  expect(next.cards.pay.input).toEqual({});
  expect(next.rewardRequests).toEqual([]);
  expect(next.operations).toEqual([]);
  expect(next.operationCards).toEqual({});
  expect(next.allowedActions).toEqual(['switch-scope', 'connect']);
});

it('edits drafts without validating amounts or carrying a previous quote or selection', () => {
  const old = populated();
  const edited = projectDraft(old, { type: 'edit', card: 'pay', field: 'amount', value: '3' });
  expect(edited.cards.pay).toMatchObject({ phase: 'invalid-input', reason: 'INPUT_INVALID', input: { amount: '3' } });
  expect(edited.cards.pay.quote).toBeUndefined();
  expect(edited.selectedInput.pay).toBeUndefined();
  expect(edited.allowedActions).not.toContain('start:pay');
  expect(projectDraft(old, { type: 'new-operation', card: 'pay' }).cards.pay.input).toEqual({});
  expect(old.cards.pay.quote).toBeDefined();
});

it.each([
  ['pending', 'none', 'pending'], ['unknown', 'none', 'unknown'], ['finalized-failure', 'none', 'failed'],
  ['finalized-success', 'pending', 'confirmed-receipt-pending'], ['finalized-success', 'confirmed', 'complete'],
  ['finalized-success', 'invalid', 'receipt-invalid'],
] as const)('projects verified %s/%s as %s', (chainOutcome, receiptState, phase) => {
  const old = populated();
  const operation: OperationRef = { ...old.operations[0]!, chainOutcome, receiptState };
  expect(mapDecisionToView(old, { scope, view: old, operation, card: 'pay' }).cards.pay.phase).toBe(phase);
});

it('does not infer completion from a transaction hash alone', () => {
  const old = populated();
  const operation: OperationRef = { ...old.operations[0]!, txHashes: [`0x${'44'.repeat(32)}` as never] };
  expect(mapDecisionToView(old, { scope, view: old, operation, card: 'pay' }).cards.pay.phase).toBe('pending');
});
