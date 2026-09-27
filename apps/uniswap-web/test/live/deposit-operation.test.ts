import { expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recipientInfoTypedData } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { OperationId, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { createDepositCoordinator } from '../../src/live/deposit.js';
import { createDepositOperation } from '../../src/live/deposit-operation.js';
import type { OperationContext } from '../../src/live/operations.js';

vi.mock('../../src/live/deposit.js', () => ({ createDepositCoordinator: vi.fn() }));

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
const pool = `0x${'22'.repeat(20)}` as const;
const operationId = `0x${'aa'.repeat(32)}` as OperationId;
const outputId = `0x${'bb'.repeat(32)}` as const;
const txHash = `0x${'cc'.repeat(32)}` as const;
const verified = { context: { chainId: 31337n, pool, verifier: `0x${'33'.repeat(20)}`,
  deploymentBlock: 1n, parametersHash: `0x${'44'.repeat(32)}`, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: pool } } } as VerifiedDeployment;
const unsigned = { chainId: 31337n, pool, owner: account.address, receivePublicKey: `0x${'55'.repeat(32)}`,
  receiptFormat: 1 as const, recipientInfoVersion: 1 as const };

function state(): ViewState {
  return { scope, currentScope: scope, connection: 'connected',
    preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [], selectedInput: {}, operationCards: {}, operationActions: {}, publicEthWei: 1n,
    availablePrivateWei: 0n, pendingPrivateWei: 0n, isStale: false, storageAvailability: 'healthy',
    cards: { reward: { phase: 'ready', input: {} }, pay: { phase: 'ready', input: {} },
      deposit: { phase: 'ready', input: { amount: '0.5' } }, withdraw: { phase: 'ready', input: {} } },
    operations: [], rewardRequests: [], allowedActions: ['start:deposit'], reasons: {} };
}

function fixture() {
  let epoch = 3;
  let snapshot = state();
  const typedSign = vi.fn(async (typed: ReturnType<typeof recipientInfoTypedData>) => ({
    scope, epoch: 3, value: await account.signTypedData(typed),
  }));
  const context = { scope, epoch: 3, check: () => { if (epoch !== 3) throw new Error('SCOPE_CHANGED'); },
    typedSign, recipientInfo: () => unsigned } as unknown as OperationContext;
  const preparedDeposit = { scope, epoch: 3, operationId, outputIds: [outputId], amountWei: 500000000000000000n,
    draft: { secret: 'must-stay-private' } } as never;
  const prepare = vi.fn(async () => preparedDeposit);
  const authorizeAndSubmit = vi.fn(async () => ({ status: 'pending' as const, operationId, outputIds: [outputId], txHash }));
  vi.mocked(createDepositCoordinator).mockReturnValue({ prepare, authorizeAndSubmit });
  const createDependencies = vi.fn(() => ({ rpc: {} as RpcConnection, resolveVerified: () => verified,
    storage: {} as never, keys: {} as never, attempts: {} as never }));
  const adapter = createDepositOperation({ snapshot: () => snapshot, createDependencies });
  return { adapter, context, prepare, authorizeAndSubmit, typedSign, createDependencies,
    publish: (value: ViewState) => { snapshot = value; }, advance: () => { epoch++; } };
}

it('parses an exact ETH amount, signs recipient info, and keeps the secret draft outside ViewState', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  expect(f.prepare).toHaveBeenCalledWith(500000000000000000n, expect.objectContaining({
    ...unsigned, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
  }));
  expect(f.typedSign).toHaveBeenCalledWith(expect.objectContaining({ primaryType: 'RecipientInfo' }), 'recipient-info');
  expect(prepared.proof).toBeUndefined();
  expect(JSON.stringify(prepared.handle)).not.toContain('secret');
  const result = await f.adapter.completePreparation(prepared, undefined, f.context);
  expect(result).toEqual({ kind: 'prepared', prepared });
  expect(f.authorizeAndSubmit).not.toHaveBeenCalled();
});

it.each(['0', '00.5', '0.1234567890123456789', ' 1', '1e2', ''])('rejects invalid amount %j before signing', async amount => {
  const f = fixture();
  await expect(f.adapter.prepareDeposit(scope, { amount }, f.context)).rejects.toThrow();
  expect(f.typedSign).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});

it('requires the original scoped handle and rejects a Worker proof', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  await expect(f.adapter.completePreparation({ ...prepared, handle: {} }, undefined, f.context)).rejects.toThrow();
  await expect(f.adapter.completePreparation(prepared, {} as never, f.context)).rejects.toThrow();
  f.advance();
  await expect(f.adapter.authorize(prepared, f.context)).rejects.toThrow('SCOPE_CHANGED');
  expect(f.authorizeAndSubmit).not.toHaveBeenCalled();
});

it('only submits on authorize and projects a hash as pending with operation identity intact', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  const result = await f.adapter.authorize(prepared, f.context);
  expect(f.authorizeAndSubmit).toHaveBeenCalledWith(expect.objectContaining({ operationId, outputIds: [outputId] }), true);
  expect(result.operation).toMatchObject({ operationId, chainOutcome: 'pending', txHashes: [txHash] });
  expect(result.view.cards.deposit.phase).toBe('pending');
  expect(result.view.availablePrivateWei).toBe(0n);
  expect(result.view.allowedActions).not.toContain('start:deposit');
  expect(f.adapter.outputIds(f.context, operationId)).toEqual([outputId]);
  expect(() => f.adapter.outputIds({ ...f.context, scope: { ...scope, deploymentId: 'other' } as Scope }, operationId))
    .toThrow('SCOPE_CHANGED');
  await expect(f.adapter.authorize(prepared, f.context)).rejects.toThrow('OPERATION_ALREADY_AUTHORIZED');
  expect(f.authorizeAndSubmit).toHaveBeenCalledTimes(1);
});

it.each([
  [{ status: 'unknown' as const, operationId, outputIds: [outputId] }, 'RESULT_UNKNOWN'],
  [{ status: 'not-submitted' as const, operationId, outputIds: [outputId], reason: 'signature-rejected' as const }, 'NOT_ALLOWED'],
  [{ status: 'not-submitted' as const, operationId, outputIds: [outputId], reason: 'insufficient-public-eth' as const }, 'GAS_REQUIRED'],
])('preserves IDs and blocks repeat submission for %j', async (result, reason) => {
  const f = fixture();
  f.authorizeAndSubmit.mockResolvedValueOnce(result as never);
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  const projected = await f.adapter.authorize(prepared, f.context);
  expect(projected.view.operations[0]?.operationId).toBe(operationId);
  expect(projected.view.cards.deposit).toMatchObject({ phase: 'unknown', reason });
  expect(f.adapter.outputIds(f.context, operationId)).toEqual([outputId]);
  expect(projected.view.allowedActions).not.toContain('start:deposit');
  await expect(f.adapter.authorize(prepared, f.context)).rejects.toThrow('OPERATION_ALREADY_AUTHORIZED');
});

it('shows a refused signature as blocked with its ID, then permits a new preparation after explicit revalidation', async () => {
  const f = fixture();
  f.authorizeAndSubmit.mockResolvedValueOnce({ status: 'not-submitted', operationId,
    outputIds: [outputId], reason: 'signature-rejected' } as never);
  const first = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  const refused = await f.adapter.authorize(first, f.context);
  expect(refused.view.cards.deposit).toMatchObject({ phase: 'unknown', reason: 'NOT_ALLOWED' });
  expect(refused.view.allowedActions).not.toContain('start:deposit');
  expect(refused.view.operations[0]?.operationId).toBe(operationId);
  f.publish(state()); // A separate sync/decision has restored readiness before the next user action.
  const next = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  expect(next.handle).not.toBe(first.handle);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.authorizeAndSubmit).toHaveBeenCalledTimes(1);
});

it('treats a failed coordinator return or throw as unknown while retaining private output IDs', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  f.authorizeAndSubmit.mockResolvedValueOnce({ status: 'pending', operationId, outputIds: [], txHash } as never);
  const projected = await f.adapter.authorize(prepared, f.context);
  expect(projected.view.cards.deposit.phase).toBe('unknown');
  expect(projected.view.operations[0]?.operationId).toBe(operationId);
  expect(f.adapter.outputIds(f.context, operationId)).toEqual([outputId]);
});

it('retains identity and disables retry when the coordinator throws after authorization starts', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareDeposit(scope, { amount: '0.5' }, f.context);
  f.authorizeAndSubmit.mockRejectedValueOnce(new Error('lost RPC response'));
  const projected = await f.adapter.authorize(prepared, f.context);
  expect(projected.view.operations[0]).toMatchObject({ operationId, chainOutcome: 'unknown' });
  expect(projected.view.cards.deposit.reason).toBe('RESULT_UNKNOWN');
  expect(f.adapter.outputIds(f.context, operationId)).toEqual([outputId]);
  await expect(f.adapter.authorize(prepared, f.context)).rejects.toThrow('OPERATION_ALREADY_AUTHORIZED');
});
