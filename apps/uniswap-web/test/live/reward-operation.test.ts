import { expect, it, vi } from 'vitest';
import type { ReceivedUtxo } from '@confidential-utxo/core';
import type { Address, Bytes32, RequestId, RewardRecord, RewardStatus, Scope, TxHash } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import type { OperationContext } from '../../src/live/operations.js';
import { createRewardOperation } from '../../src/live/reward-operation.js';
import { RewardRequestUncertain, type ScopedRewardClient } from '../../src/live/reward-client.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const requestId = `0x${'aa'.repeat(32)}` as RequestId;
const otherId = `0x${'bb'.repeat(32)}` as RequestId;
const operationId = `0x${'cc'.repeat(32)}` as RewardRecord['operationId'];
const record = (status: RewardStatus, id = requestId): RewardRecord => ({ scope, requestId: id, amountWei: 7n,
  recipientInfo: { owner: scope.owner, publicKey: `0x${'dd'.repeat(32)}` as Bytes32, signature: `0x${'ee'.repeat(65)}` as `0x${string}` },
  status, operationId, attemptIds: [], txHashes: [`0x${'ff'.repeat(32)}` as TxHash] });

function state(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [], selectedInput: {}, operationCards: {}, operationActions: {}, publicEthWei: 0n,
    availablePrivateWei: 0n, pendingPrivateWei: 0n, isStale: false, storageAvailability: 'healthy',
    cards: { reward: { phase: 'ready', input: { amount: '0.000000000000000007' } }, pay: { phase: 'ready', input: {} },
      deposit: { phase: 'ready', input: {} }, withdraw: { phase: 'ready', input: {} } },
    operations: [], rewardRequests: [], allowedActions: ['start:reward', 'start:pay'], reasons: {} };
}

function fixture() {
  let snapshot = state();
  let epoch = 1;
  const context = { scope, epoch: 1, check: () => { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); } } as OperationContext;
  const client = { request: vi.fn(async () => record('accepted')), recheck: vi.fn(async () => record('pending')),
    list: vi.fn(async () => [record('queued')]), markReceived: vi.fn(async () => record('received')) } satisfies ScopedRewardClient;
  const newRequestId = vi.fn(() => requestId);
  const adapter = createRewardOperation({ snapshot: () => snapshot, client: () => client, newRequestId });
  return { adapter, client, context, newRequestId, get snapshot() { return snapshot; },
    publish: (next: ViewState) => { snapshot = next; }, advance: () => { epoch++; } };
}

it('starts one fixed request, exposes only public references, and does not infer success from a hash', async () => {
  const f = fixture();
  const result = await f.adapter.start(scope, { amount: '0.000000000000000007' }, f.context);
  expect(f.client.request).toHaveBeenCalledWith('7', requestId);
  expect(result.view.cards.reward.phase).toBe('pending');
  expect(result.view.rewardRequests).toEqual([{ requestId, status: 'accepted', operationId }]);
  expect(result.view.allowedActions).toContain('recheck-reward');
  expect(result.view.allowedActions).not.toContain('start:reward');
  expect(JSON.stringify(result.view, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('eeee');
  expect(result.view.availablePrivateWei).toBe(0n);
});

it('keeps the request ID after an uncertain POST and rechecks without another POST or new ID', async () => {
  const f = fixture();
  f.client.request.mockRejectedValueOnce(new RewardRequestUncertain(requestId, new Error('lost ACK')));
  const unknown = await f.adapter.start(scope, { amount: '0.000000000000000007' }, f.context);
  expect(unknown.view.rewardRequests).toEqual([{ requestId, status: 'unknown' }]);
  expect(unknown.view.cards.reward.phase).toBe('unknown');
  f.publish(unknown.view);
  const checked = await f.adapter.start(scope, { amount: '0.000000000000000009' }, f.context);
  expect(f.client.recheck).toHaveBeenCalledWith(requestId);
  expect(f.client.request).toHaveBeenCalledTimes(1);
  expect(f.newRequestId).toHaveBeenCalledTimes(1);
  expect(checked.view.rewardRequests[0]?.status).toBe('pending');
});

it.each([['accepted', 'pending'], ['queued', 'pending'], ['processing', 'pending'], ['pending', 'pending'],
  ['finalized', 'confirmed-receipt-pending'], ['received', 'complete'], ['unknown', 'unknown'],
  ['ended-without-distribution', 'failed']] as const)('maps %s distinctly from receipt completion', async (status, expectedPhase) => {
  const f = fixture();
  f.publish({ ...f.snapshot, rewardRequests: [{ requestId, status: 'pending' }] });
  f.client.recheck.mockResolvedValueOnce(record(status));
  const result = await f.adapter.recheck(scope, requestId, f.context);
  expect(result.view.rewardRequests[0]?.status).toBe(status);
  expect(result.view.cards.reward.phase).toBe(expectedPhase);
  expect(result.view.availablePrivateWei).toBe(0n);
});

it('lists scoped records for recovery and requires core inspected receipt to mark received', async () => {
  const f = fixture();
  f.client.list.mockResolvedValueOnce([record('finalized', otherId)]);
  const listed = await f.adapter.list(scope, f.context);
  expect(listed.view.rewardRequests).toEqual([{ requestId: otherId, status: 'finalized', operationId }]);
  f.publish(listed.view);
  const receipt = { status: 'available' } as ReceivedUtxo;
  f.client.markReceived.mockResolvedValueOnce(record('received', otherId));
  const received = await f.adapter.receive(scope, otherId, receipt, f.context);
  expect(f.client.markReceived).toHaveBeenCalledWith(otherId, receipt);
  expect(received.view.cards.reward.phase).toBe('complete');
  expect(received.view.availablePrivateWei).toBe(0n);
});

it('does not treat an empty service list as proof that an uncertain request was never accepted', async () => {
  const f = fixture();
  f.publish({ ...f.snapshot, rewardRequests: [{ requestId, status: 'unknown' }] });
  f.client.list.mockResolvedValueOnce([]);
  const listed = await f.adapter.list(scope, f.context);
  expect(listed.view.rewardRequests).toEqual([{ requestId, status: 'unknown' }]);
  expect(listed.view.allowedActions).not.toContain('start:reward');
  expect(listed.view.allowedActions).toContain('recheck-reward');
});

it('fails closed on unavailable service, stale start, wrong scope and epoch change', async () => {
  const f = fixture();
  f.client.list.mockRejectedValueOnce(new Error('SERVICE_UNAVAILABLE'));
  await expect(f.adapter.list(scope, f.context)).rejects.toThrow('SERVICE_UNAVAILABLE');
  f.publish({ ...f.snapshot, isStale: true });
  await expect(f.adapter.start(scope, { amount: '1' }, f.context)).rejects.toThrow('SERVICE_UNAVAILABLE');
  expect(f.client.request).not.toHaveBeenCalled();
  await expect(f.adapter.list({ ...scope, owner: `0x${'22'.repeat(20)}` as Address }, f.context)).rejects.toThrow('SCOPE_CHANGED');
  f.advance();
  await expect(f.adapter.list(scope, f.context)).rejects.toThrow('SCOPE_CHANGED');
});

it('rejects a returned record in another scope and does not publish it', async () => {
  const f = fixture();
  f.client.list.mockResolvedValueOnce([{ ...record('received'), scope: { ...scope, owner: `0x${'22'.repeat(20)}` as Address } }]);
  await expect(f.adapter.list(scope, f.context)).rejects.toThrow('SCOPE_CHANGED');
});
