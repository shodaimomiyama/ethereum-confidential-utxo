import { expect, it } from 'vitest';
import type { Context, HistoryPort, OwnedUtxo, ReceiptKeyPort, SyncResult } from '@confidential-utxo/core';
import type { OperationId, OperationRef, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { projectCoreSync, syncFinalizedForView } from '../../src/live/sync-projection.js';

const owner = `0x${'11'.repeat(20)}` as const;
const pool = `0x${'22'.repeat(20)}` as const;
const hash = `0x${'33'.repeat(32)}` as const;
const id = `0x${'44'.repeat(32)}` as OperationId;
const scope = { deploymentId: 'local', owner } as Scope;
const coreContext: Context = { chainId: 31337n, pool, deploymentBlock: 1n,
  verifier: `0x${'55'.repeat(20)}`, parametersHash: `0x${'66'.repeat(32)}`, finalityMode: 'local-simulated' };
const checkpoint = { number: 4n, hash, mode: 'local-simulated' as const };
const keys: ReceiptKeyPort = { getKey: async () => { throw new Error('No outputs in this fixture'); } };
const operation: OperationRef = { scope, operationId: id, attemptIds: [], txHashes: [],
  chainOutcome: 'finalized-success', receiptState: 'confirmed' };

function view(): ViewState {
  return { scope, currentScope: scope, connection: 'connected',
    preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [{ id: 'old', amountWei: 5n, available: true }],
    selectedInput: { pay: { id: 'old', amountWei: 5n, changeWei: 1n } },
    operationCards: { [id]: 'pay' }, operationActions: { [id]: ['recheck', 'retry-attempt'] },
    publicEthWei: 7n, availablePrivateWei: 5n, pendingPrivateWei: 0n, checkedAt: 1,
    isStale: false, storageAvailability: 'healthy',
    cards: { reward: { phase: 'ready', input: {} }, pay: { phase: 'complete', input: {} },
      deposit: { phase: 'ready', input: {} }, withdraw: { phase: 'ready', input: {} } },
    operations: [operation], rewardRequests: [], allowedActions: ['resync', 'start:pay', 'retry-attempt'], reasons: {} };
}

function history(complete = true): HistoryPort {
  return {
    getFinalizedCheckpoint: async () => checkpoint,
    getContext: async () => ({ complete: true, blockHash: hash, value: coreContext }),
    getOperations: async () => complete ? { complete: true, blockHash: hash, value: [] }
      : { complete: false, reason: 'GAP' },
    getCanonicalHeader: async () => ({ complete: true, blockHash: hash, value: { number: 4n, hash } }),
    getUtxo: async () => { throw new Error('No outputs in this fixture'); },
    getOperationSuccess: async () => { throw new Error('No operations in this fixture'); },
    getLatestHeader: async () => null,
    getLatestUtxo: async () => { throw new Error('Unused'); },
    getLatestOperationSuccess: async () => { throw new Error('Unused'); },
  };
}

it('only publishes the core complete balance and never authorizes an action from sync alone', async () => {
  const prior = view();
  const action = { scope, epoch: 1, check() {} };
  const result = await syncFinalizedForView({ previous: prior, action, coreContext, history: history(), keys });
  expect(result.core.status).toBe('complete');
  expect(result.view.availablePrivateWei).toBe(0n);
  expect(result.view.utxos).toEqual([]);
  expect(result.view.isStale).toBe(false);
  expect(result.view.allowedActions).not.toContain('start:pay');
  expect(result.view.operations).toEqual([{ ...operation, chainOutcome: 'unknown' }]);
  expect(result.view.operationActions[id]).toEqual(['recheck']);
  expect(result.view.publicEthWei).toBe(0n);
  expect(result.view.preparation.gas).toBe(false);
});

it('keeps the original ID and disables spendability when history has a gap', async () => {
  const prior = view();
  const result = await syncFinalizedForView({ previous: prior,
    action: { scope, epoch: 1, check() {} }, coreContext, history: history(false), keys });
  expect(result.core).toMatchObject({ status: 'unconfirmed', reason: 'INCOMPLETE_HISTORY' });
  expect(result.view.isStale).toBe(true);
  expect(result.view.utxos).toEqual([{ id: 'old', amountWei: 5n, available: false }]);
  expect(result.view.operations[0]).toMatchObject({ operationId: id, chainOutcome: 'unknown' });
  expect(result.view.allowedActions).not.toContain('start:pay');
});

it('uses only core available UTXOs and preserves unknown IDs on a fresh checkpoint', () => {
  const owned = (id: string, amount: bigint, status: OwnedUtxo['status']): OwnedUtxo => ({
    id: id as `0x${string}`, owner, chainId: coreContext.chainId, pool, checkpoint, status,
    opening: { amount } as OwnedUtxo['opening'], commitment: { x: 1n, y: 2n },
  });
  const result: SyncResult = { status: 'complete', checkpoint,
    utxos: [owned(`0x${'77'.repeat(32)}`, 3n, 'available'), owned(`0x${'88'.repeat(32)}`, 2n, 'spent')],
    availableWei: 3n, receiptFailures: [] };
  const next = projectCoreSync(view(), result);
  expect(next.isStale).toBe(false);
  expect(next.availablePrivateWei).toBe(3n);
  expect(next.utxos).toEqual([
    { id: `0x${'77'.repeat(32)}`, amountWei: 3n, available: true },
    { id: `0x${'88'.repeat(32)}`, amountWei: 2n, available: false },
  ]);
  expect(next.selectedInput).toEqual({});
  expect(next.operations[0]).toMatchObject({ operationId: id, chainOutcome: 'unknown' });
});

it('does not accept a result after the action epoch changes', async () => {
  let checks = 0;
  await expect(syncFinalizedForView({ previous: view(), action: { scope, epoch: 1,
    check() { if (++checks > 1) throw new Error('SCOPE_CHANGED'); } },
    coreContext, history: history(), keys })).rejects.toThrow('SCOPE_CHANGED');
});
