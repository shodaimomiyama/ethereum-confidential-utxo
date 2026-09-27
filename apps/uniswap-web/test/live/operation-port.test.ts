import { expect, it, vi } from 'vitest';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { PaymentClient, PreparedPay, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { createOperationPort, type OperationPortDependencies } from '../../src/live/operation-port.js';
import type { OperationContext } from '../../src/live/operations.js';

const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'aa'.repeat(32)}`;
const initialHash = `0x${'bb'.repeat(32)}`;
const changedHash = `0x${'cc'.repeat(32)}`;
const coreContext = { chainId: 31337n, pool: `0x${'22'.repeat(20)}`, verifier: `0x${'33'.repeat(20)}`,
  parametersHash: `0x${'44'.repeat(32)}`, deploymentBlock: 0n, finalityMode: 'finalized' };
const verified = { context: coreContext, manifest: { chainId: 31337, pool: { address: coreContext.pool } } } as unknown as VerifiedDeployment;
function state(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [{ id: 'coin', amountWei: 10n, available: true }], selectedInput: {}, operationCards: {}, operationActions: {},
    publicEthWei: 1n, availablePrivateWei: 10n, pendingPrivateWei: 0n, isStale: false, storageAvailability: 'healthy',
    cards: { reward: { phase: 'ready', input: {} }, pay: { phase: 'ready', input: { amount: '1' } },
      deposit: { phase: 'ready', input: {} }, withdraw: { phase: 'ready', input: {} } },
    operations: [], rewardRequests: [], allowedActions: ['start:pay', 'confirm-terms', 'resync'], reasons: {} };
}
const prepared = (hash: string): PreparedPay => ({ record: { kind: 'pay', scope, operationId: id,
  inputId: `0x${'dd'.repeat(32)}`, recordId: `0x${'ee'.repeat(32)}`, contentHash: hash, paymentId: `0x${'ff'.repeat(32)}` },
  privateBytes: new Uint8Array([7]), poolAuthorization: {}, quote: { startedAtMs: 0, blockHash: initialHash,
    blockNumber: 1n, inputWei: 1n, quoteOut: hash === initialHash ? 100n : 200n } }) as unknown as PreparedPay;
function setup() {
  let current = state();
  let epoch = 1;
  let now = 31_000;
  const signed = vi.fn(async () => ({ scope, operationId: id, paymentId: `0x${'ff'.repeat(32)}`,
    attemptIds: ['a'], txHashes: [], chainOutcome: 'unknown', receiptState: 'none' }));
  const client = { preparePay: vi.fn(async () => prepared(initialHash)), authorizePay: signed } as unknown as PaymentClient;
  const refreshPay = vi.fn(async () => prepared(changedHash));
  const context = { scope, epoch: 1, check() { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); } } as OperationContext;
  const deps = { snapshot: () => current, resolveVerified: () => ({ deploymentId: scope.deploymentId, verified }),
    payment: () => ({ client, refreshPay, terms: () => ({ minAmountOut: 90n, deadline: 600n }), now: () => now }),
    reward: {}, deposit: {}, coreSync: () => ({ deploymentId: scope.deploymentId, coreContext, history: {}, keys: {} }),
    recheck: vi.fn(), resumeOriginal: vi.fn(), retryAttempt: vi.fn(), receive: vi.fn() } as unknown as OperationPortDependencies;
  const port = createOperationPort(deps);
  return { port, context, deps, signed, refreshPay, publish: (view: ViewState) => { current = view; },
    invalidate: () => { epoch++; }, setNow: (value: number) => { now = value; }, client };
}

it('accepts setup transitions only after the controller completed the scoped key and auth work', async () => {
  const fixture = setup();
  const keyReady = { ...fixture.context, recordKey: () => ({}) } as OperationContext;
  const prepared = await fixture.port.transition(scope, { type: 'prepare-key' }, state(), keyReady);
  expect(prepared.view.preparation.key).toBe(true);
  expect(prepared.view.allowedActions).toContain('authenticate');
  const authenticated = await fixture.port.transition(scope, { type: 'authenticate' }, prepared.view, keyReady);
  expect(authenticated.view.allowedActions).toContain('resync');
  await expect(fixture.port.transition(scope, { type: 'prepare-key' }, state(), fixture.context)).rejects.toThrow();
});

it('rejects a #55 operation reference for another operation and retains the original ID', async () => {
  const fixture = setup();
  fixture.setNow(10);
  fixture.signed.mockResolvedValueOnce({ scope, operationId: `0x${'99'.repeat(32)}`, paymentId: `0x${'ff'.repeat(32)}`,
    attemptIds: [], txHashes: [], chainOutcome: 'unknown', receiptState: 'none' });
  const first = await fixture.port.preparePay(scope, { amount: '1' }, fixture.context);
  await expect(fixture.port.authorize(first, fixture.context)).rejects.toThrow('SCOPE_CHANGED');
  const failed = fixture.port.failure(scope, { type: 'start', card: 'pay' }, state(), new Error('SCOPE_CHANGED'));
  expect(failed.view.operations[0]?.operationId).toBe(id);
});

it('restores scoped key readiness after complete core sync and uses only an injected fresh action decision', async () => {
  const fixture = setup();
  const blockHash = `0x${'66'.repeat(32)}` as `0x${string}`;
  const checkpoint = { number: 4n, hash: blockHash, mode: 'finalized' as const };
  const history = {
    getFinalizedCheckpoint: async () => checkpoint,
    getContext: async () => ({ complete: true, blockHash, value: coreContext }),
    getOperations: async () => ({ complete: true, blockHash, value: [] }),
    getCanonicalHeader: async () => ({ complete: true, blockHash, value: { number: 4n, hash: blockHash } }),
  };
  const recomputeReady = vi.fn(async ({ view }: { view: ViewState }) => ({
    cards: view.cards, selectedInput: view.selectedInput, reasons: view.reasons,
    allowedActions: ['resync', 'start:reward'],
  }));
  const deps = { ...fixture.deps, coreSync: () => ({ deploymentId: scope.deploymentId, coreContext, history, keys: {} }),
    recomputeReady } as unknown as OperationPortDependencies;
  const context = { ...fixture.context, recordKey: () => ({}) } as OperationContext;
  const synced = await createOperationPort(deps).syncFinalized(scope, context);
  expect(synced.view.preparation.key).toBe(true);
  expect(recomputeReady).toHaveBeenCalledOnce();
  expect(recomputeReady.mock.calls[0]![0].view.isStale).toBe(false);
  expect(synced.view.allowedActions).toContain('start:reward');
  const withoutDecision = await createOperationPort({ ...deps, recomputeReady: undefined }).syncFinalized(scope, context);
  expect(withoutDecision.view.allowedActions).not.toContain('start:reward');
  expect(withoutDecision.view.preparation.key).toBe(true);
});

it('holds refreshed terms until an explicit same-epoch confirmation and keeps the secret out of ViewState', async () => {
  const fixture = setup();
  const first = await fixture.port.preparePay(scope, { amount: '1' }, fixture.context);
  const completed = await fixture.port.completePreparation(first, undefined, fixture.context);
  expect(completed.kind).toBe('decision');
  if (completed.kind !== 'decision') return;
  expect(completed.result.view.cards.pay).toMatchObject({ phase: 'confirm-terms', proposedQuote: { quoteOut: 200n } });
  expect(fixture.signed).not.toHaveBeenCalled();
  expect(JSON.stringify(completed.result.view, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('privateBytes');
  fixture.publish(completed.result.view);
  const accepted = await fixture.port.transition(scope, { type: 'confirm-terms', card: 'pay' }, completed.result.view, fixture.context);
  expect(fixture.signed).toHaveBeenCalledOnce();
  expect(fixture.signed).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ contentHash: changedHash }) }), changedHash);
  expect(accepted.operation?.chainOutcome).toBe('unknown');
  expect(accepted.view.availablePrivateWei).toBe(10n);
  expect(accepted.view.utxos[0]?.available).toBe(false);
  expect(accepted.view.allowedActions).not.toContain('start:pay');
  expect(accepted.view.operations[0]?.operationId).toBe(id);
});

it('rejects a changed epoch or edited draft before confirmation', async () => {
  const fixture = setup();
  const first = await fixture.port.preparePay(scope, { amount: '1' }, fixture.context);
  const completed = await fixture.port.completePreparation(first, undefined, fixture.context);
  if (completed.kind !== 'decision') throw new Error('fixture');
  fixture.publish(completed.result.view);
  fixture.invalidate();
  await expect(fixture.port.transition(scope, { type: 'confirm-terms', card: 'pay' }, completed.result.view, fixture.context)).rejects.toThrow('SCOPE_CHANGED');
  expect(fixture.signed).not.toHaveBeenCalled();
});

it('drops pending confirmation after the pay input is edited', async () => {
  const fixture = setup();
  const first = await fixture.port.preparePay(scope, { amount: '1' }, fixture.context);
  const completed = await fixture.port.completePreparation(first, undefined, fixture.context);
  if (completed.kind !== 'decision') throw new Error('fixture');
  fixture.publish(completed.result.view);
  const edited = await fixture.port.transition(scope, { type: 'edit', card: 'pay', field: 'amount', value: '2' },
    completed.result.view, fixture.context);
  fixture.publish(edited.view);
  await expect(fixture.port.transition(scope, { type: 'confirm-terms', card: 'pay' }, edited.view, fixture.context)).rejects.toThrow('NOT_ALLOWED');
  expect(fixture.signed).not.toHaveBeenCalled();
});

it('retains the operation ID as unknown after an authorization failure', async () => {
  const fixture = setup();
  fixture.setNow(10);
  fixture.signed.mockRejectedValueOnce(new Error('lost ACK'));
  const first = await fixture.port.preparePay(scope, { amount: '1' }, fixture.context);
  const completed = await fixture.port.completePreparation(first, undefined, fixture.context);
  if (completed.kind !== 'prepared') throw new Error('fixture');
  await expect(fixture.port.authorize(completed.prepared, fixture.context)).rejects.toThrow('lost ACK');
  const failed = fixture.port.failure(scope, { type: 'start', card: 'pay' }, state(), new Error('lost ACK'));
  expect(failed.view.operations).toMatchObject([{ operationId: id, chainOutcome: 'unknown' }]);
  expect(failed.view.operationActions[id]).toContain('recheck');
  expect(failed.view.allowedActions).not.toContain('start:pay');
  expect(failed.view.utxos[0]?.available).toBe(false);
});

it('rejects a sync supplier whose context belongs to another deployment', async () => {
  const fixture = setup();
  const wrong = { ...coreContext, pool: `0x${'99'.repeat(20)}` };
  const deps = { snapshot: state, resolveVerified: () => ({ deploymentId: scope.deploymentId, verified }),
    payment: () => { throw new Error('unused'); }, reward: {}, deposit: {},
    coreSync: () => ({ deploymentId: scope.deploymentId, coreContext: wrong, history: {}, keys: {} }),
    recheck: vi.fn(), resumeOriginal: vi.fn(), retryAttempt: vi.fn(), receive: vi.fn() } as unknown as OperationPortDependencies;
  await expect(createOperationPort(deps).syncFinalized(scope, fixture.context)).rejects.toThrow('SCOPE_CHANGED');
});
