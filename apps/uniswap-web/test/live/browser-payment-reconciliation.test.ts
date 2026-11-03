import { beforeEach, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { inspectReceipt } from '@confidential-utxo/core';
import { adapterAbi, paymentDigest, type PaymentTerms } from '@confidential-utxo/uniswap';
import { createScopedEthereumBridge } from '../../src/live/ethereum.js';
import { openPaymentPrivateRecord } from '../../src/live/payment-record.js';
import { createBrowserPaymentReconciliation, type BrowserPaymentReconciliationDependencies } from '../../src/live/browser-payment-reconciliation.js';

vi.mock('../../src/live/ethereum.js', () => ({ createScopedEthereumBridge: vi.fn() }));
vi.mock('../../src/live/payment-record.js', () => ({ openPaymentPrivateRecord: vi.fn() }));
vi.mock('@confidential-utxo/core', async original => ({ ...await original<typeof import('@confidential-utxo/core')>(),
  inspectReceipt: vi.fn(async () => ({ status: 'unknown', reason: 'KEY_UNAVAILABLE' })) }));
vi.mock('@confidential-utxo/uniswap', async original => ({ ...await original<typeof import('@confidential-utxo/uniswap')>(),
  assertWithdrawalBinding: vi.fn() }));

const hash = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const address = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const scope = { deploymentId: 'local', owner: address('1') };
  const deployment = { chainId: 31337n, pool: address('2'), adapter: address('3'), token: address('4'),
    router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
  const coreContext = { chainId: 31337n, pool: deployment.pool, verifier: address('9'),
    parametersHash: hash('a'), finalityMode: 'local-simulated', deploymentBlock: 0n };
  const verified = { context: coreContext, manifest: { chainId: 31337, pool: { address: deployment.pool } } };
  const terms = { operationId: hash('1'), owner: scope.owner, ethAmount: 3n, token: deployment.token,
    minAmountOut: 4n, recipient: address('a'), deadline: 500n } as PaymentTerms;
  const paymentId = paymentDigest(terms, 31337n, deployment.adapter as never);
  const args = { ...terms, paymentId, amountOut: 6n };
  const eventAbi = adapterAbi.find(item => item.type === 'event' && item.name === 'PaymentSucceeded')!;
  const log = { address: deployment.adapter, transactionHash: hash('2'), blockHash: hash('3'), blockNumber: 2n,
    logIndex: 1, transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: adapterAbi, eventName: 'PaymentSucceeded', args }),
    data: encodeAbiParameters(eventAbi.inputs.filter(input => !input.indexed),
      [terms.ethAmount, terms.token, terms.minAmountOut, terms.recipient, terms.deadline, 6n]) };
  const request = { owner: scope.owner, inputIds: [hash('4')], outputs: [{}] };
  const draft = { context: coreContext, request, outputIds: [hash('5')] };
  vi.mocked(openPaymentPrivateRecord).mockResolvedValue({ creationInputs: draft,
    intendedAuthorization: { payment: { message: terms } } } as never);
  const point = { number: 10n, hash: hash('6'), mode: 'local-simulated' };
  const observation = (value: unknown) => ({ complete: true, blockHash: point.hash, value });
  const operation = observation({ executed: true, operation: request });
  const consumed = observation({ executed: true, operation: { inputIds: [hash('5')] } });
  const observed = { request, success: { operationId: terms.operationId, blockNumber: 2n,
    blockHash: log.blockHash, transactionHash: log.transactionHash }, outputLogs: [] };
  const history = { getFinalizedCheckpoint: vi.fn(async () => point),
    getOperations: vi.fn(async () => observation([observed])),
    getOperationSuccess: vi.fn(async (id: string) => id === hash('7') ? consumed : operation),
    getUtxo: vi.fn(async (id: string) => observation(id === hash('4')
      ? { exists: true, owner: scope.owner, consumedBy: terms.operationId }
      : { exists: true, owner: scope.owner, consumedBy: hash('7') })),
    getCanonicalHeader: vi.fn(async () => observation({ number: 2n, hash: log.blockHash })),
  };
  vi.mocked(createScopedEthereumBridge).mockReturnValue({ history } as never);
  const client = { getChainId: vi.fn(async () => 31337), getBlock: vi.fn(async () => ({ hash: point.hash })),
    getLogs: vi.fn(async () => [log]), getTransactionReceipt: vi.fn(async () => ({ status: 'success',
      transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: 2n, logs: [log] })) };
  const context = { scope, epoch: 1, check: vi.fn(), recordKey: () => ({}),
    recipientPrivateKeyForWorker: () => { throw new Error('unused'); } };
  const deps = { context, verified, deployment, resolveVerified: () => verified, resolveDeployment: () => deployment,
    rpc: { client, mode: 'local-simulated', policy: { chunkBlocks: 100n, minChunkBlocks: 1n,
      retries: 0, requestTimeoutMs: 1000, overallTimeoutMs: 2000 } } } as unknown as BrowserPaymentReconciliationDependencies;
  const ref = { scope, operationId: terms.operationId, paymentId };
  const saved = { revision: 1, record: { kind: 'pay', scope, recordId: hash('8'), operationId: terms.operationId,
    paymentId, deadline: terms.deadline, inputId: hash('4') } };
  const read = () => createBrowserPaymentReconciliation(deps).readFinalized(ref as never, saved as never);
  return { deps, read, client, history, context, point, consumed, ref, saved, log, observed };
}

it('binds adapter and Pool success to one checkpoint and inspects a subsequently spent change', async () => {
  const f = fixture();
  const result = await f.read();
  expect(result.history.adapter?.paymentId).toBe(f.ref.paymentId);
  expect(result.history.input?.consumed).toBe(true);
  expect(result.history.blockHash).toBe(f.log.blockHash);
  expect(f.history.getOperationSuccess).toHaveBeenCalledWith(hash('7'), f.point);
  expect(vi.mocked(inspectReceipt).mock.calls[0]?.[4].consumingOperation).toEqual(f.consumed);
  expect(f.client.getBlock).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'duplicate', 'wrong-contract'] as const)('does not invent success from %s adapter logs', async mode => {
  const f = fixture();
  f.client.getLogs.mockResolvedValue(mode === 'missing' ? [] : mode === 'duplicate'
    ? [f.log, f.log] : [{ ...f.log, address: address('b') }]);
  expect((await f.read()).history.adapter).toBeUndefined();
  expect(inspectReceipt).not.toHaveBeenCalled();
});

it('rejects Pool success from a different transaction', async () => {
  const f = fixture();
  f.observed.success.transactionHash = hash('9');
  expect((await f.read()).history.adapter).toBeUndefined();
  expect(inspectReceipt).not.toHaveBeenCalled();
});

it('rejects incomplete and mismatched checkpoint observations', async () => {
  const f = fixture();
  f.history.getOperations.mockResolvedValue({ complete: true, blockHash: hash('a'), value: [f.observed] });
  await expect(f.read()).rejects.toThrow('PAYMENT_HISTORY_UNAVAILABLE');
});

it('rejects reorg while Worker receipt verification is in progress', async () => {
  const f = fixture();
  f.client.getBlock.mockResolvedValueOnce({ hash: f.point.hash }).mockResolvedValueOnce({ hash: hash('b') });
  await expect(f.read()).rejects.toThrow('PAYMENT_CHECKPOINT_REORG');
});

it('drops delayed RPC results after a connection switch', async () => {
  const f = fixture();
  f.client.getLogs.mockImplementation(async () => {
    f.context.epoch = 2;
    return [f.log];
  });
  await expect(f.read()).rejects.toThrow('SCOPE_CHANGED');
  expect(inspectReceipt).not.toHaveBeenCalled();
});

it('refuses a mutated deployment before issuing any RPC call', async () => {
  const f = fixture();
  const adapter = createBrowserPaymentReconciliation(f.deps);
  Object.assign(f.deps.deployment, { adapter: address('f') });
  await expect(adapter.readFinalized(f.ref as never, f.saved as never)).rejects.toThrow('SCOPE_CHANGED');
  expect(f.client.getChainId).not.toHaveBeenCalled();
});
