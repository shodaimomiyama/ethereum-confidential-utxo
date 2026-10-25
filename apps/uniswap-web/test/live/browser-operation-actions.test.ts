import { expect, it, vi } from 'vitest';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, DeploymentId, OperationId, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { createBrowserOperationActions } from '../../src/live/browser-operation-actions.js';
import type { OperationContext } from '../../src/live/operations.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const scope: Scope = { deploymentId: 'local' as DeploymentId, owner: address('1') };
const id = hash('a') as OperationId;
const recordId = hash('b');
const verified = { context: { chainId: 31337n, pool: address('2'), verifier: address('3'),
  parametersHash: hash('4'), deploymentBlock: 0n, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: address('2') } } } as unknown as VerifiedDeployment;
const context = { scope, epoch: 1, check() {} } as OperationContext;
function view(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true, network: true,
    key: true, faucet: false, gas: true }, utxos: [], selectedInput: {}, operationCards: { [id]: 'withdraw' },
    operationActions: { [id]: ['recheck'] }, publicEthWei: 1n, availablePrivateWei: 0n,
    pendingPrivateWei: 0n, isStale: false, storageAvailability: 'healthy', cards: {
      reward: { phase: 'needs-preparation', input: {} }, pay: { phase: 'needs-preparation', input: {} },
      deposit: { phase: 'needs-preparation', input: {} }, withdraw: { phase: 'unknown', input: {} },
    }, operations: [{ scope, operationId: id, attemptIds: [], txHashes: [],
      chainOutcome: 'unknown', receiptState: 'none' }], rewardRequests: [], allowedActions: [], reasons: {} };
}
function fixture(records: readonly unknown[]) {
  let current = view();
  const resumeOriginal = vi.fn(async () => ({ kind: 'unknown' as const }));
  const retryAttempt = vi.fn(async () => ({ kind: 'not-submitted' as const }));
  const list = vi.fn(async () => ({ availability: 'healthy' as const, records }));
  const unused = () => { throw new Error('unused'); };
  const actions = createBrowserOperationActions({ snapshot: () => current,
    resolveVerified: () => verified, history: unused, receiptKeys: unused,
    reservations: () => ({ list }) as never,
    payment: () => ({ client: { resumeOriginal, retryAttempt, reconcile: unused } }) as never,
    paymentRecovery: unused, reward: { start: unused, recheck: unused, list: unused, listFrom: unused, receive: unused } });
  return { actions, list, resumeOriginal, retryAttempt, publish: (next: ViewState) => { current = next; } };
}
const saved = { scope, record: { scope, kind: 'withdraw', operationId: id, recordId,
  attemptIds: [] }, revision: 1, reservationState: 'active' };

it('resolves a single server record by operation ID and preserves unknown submission', async () => {
  const f = fixture([saved]);
  const result = await f.actions.resumeOriginal(scope, id, context, view());
  expect(f.resumeOriginal).toHaveBeenCalledWith(recordId);
  expect(result.view.operations[0]).toMatchObject({ operationId: id, chainOutcome: 'unknown' });
  expect(result.view.operationActions[id]).toEqual(['recheck']);
});

it('refuses duplicate operation IDs before a retry can submit', async () => {
  const f = fixture([saved, { ...saved, record: { ...saved.record, recordId: hash('c') } }]);
  await expect(f.actions.retryAttempt(scope, id, context, view())).rejects.toThrow('AMBIGUOUS_OPERATION');
  expect(f.retryAttempt).not.toHaveBeenCalled();
});

it('chooses the unique active successor after a released Pay term change', async () => {
  const active = { ...saved, record: { ...saved.record, kind: 'pay', recordId: hash('c'), paymentId: hash('d') } };
  const released = { ...active, record: { ...active.record, recordId }, reservationState: 'released' };
  const f = fixture([released, active]);
  const previous = { ...view(), operationCards: { [id]: 'pay' as const } };
  await f.actions.resumeOriginal(scope, id, context, previous);
  expect(f.resumeOriginal).toHaveBeenCalledWith(active.record.recordId);
});

it('keeps a deposit unknown when finalized chain evidence is unavailable', async () => {
  const previous = { ...view(), operationCards: { [id]: 'deposit' as const } };
  const unused = () => { throw new Error('unused'); };
  const actions = createBrowserOperationActions({ snapshot: () => previous,
    resolveVerified: () => verified,
    history: () => ({ getFinalizedCheckpoint: async () => null }) as never,
    receiptKeys: unused, reservations: unused, payment: unused, paymentRecovery: unused,
    reward: { start: unused, recheck: unused, list: unused, listFrom: unused, receive: unused } });
  const result = await actions.recheck(scope, id, context, previous);
  expect(result.view.operations[0]).toMatchObject({ operationId: id, chainOutcome: 'unknown' });
  expect(result.view.operationActions[id]).toEqual(['recheck']);
});
