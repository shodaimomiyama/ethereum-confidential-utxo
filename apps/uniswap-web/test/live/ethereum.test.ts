import { beforeEach, expect, it, vi } from 'vitest';
import type { PublicSubmission, HistoryPort } from '@confidential-utxo/core';
import { createHistoryPort, submitPublicOperation, type VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Scope } from '@confidential-utxo/uniswap';
import type { RpcConnection } from '@confidential-utxo/ethereum';
import { createScopedEthereumBridge } from '../../src/live/ethereum.js';
import type { OperationContext } from '../../src/live/operations.js';

vi.mock('@confidential-utxo/ethereum', () => ({ createHistoryPort: vi.fn(), submitPublicOperation: vi.fn() }));

const owner = `0x${'11'.repeat(20)}`;
const pool = `0x${'22'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const manifest = { chainId: 31337, pool: { address: pool } };
const verified = { manifest, context: { chainId: 31337n, pool, verifier: `0x${'33'.repeat(20)}`,
  deploymentBlock: 1n, parametersHash: `0x${'44'.repeat(32)}`, finalityMode: 'local-simulated' } } as VerifiedDeployment;
const rpc = { mode: 'local-simulated', client: {
  getChainId: vi.fn(async () => 31337), estimateGas: vi.fn(async () => 100_000n),
  estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 4n, maxPriorityFeePerGas: 1n })),
  getBalance: vi.fn(async () => 1_000_000n), getTransactionCount: vi.fn(async () => 4),
}, policy: {} } as unknown as RpcConnection;

function fixture() {
  let epoch = 7;
  let current: VerifiedDeployment | undefined = verified;
  const sendTransaction = vi.fn(async () => ({ value: `0x${'aa'.repeat(32)}`, scope, epoch }));
  const context = { scope, epoch: 7, check: () => { if (epoch !== 7) throw new Error('SCOPE_CHANGED'); },
    sendTransaction } as unknown as OperationContext;
  const latest = vi.fn(async () => ({ number: 3n, hash: `0x${'bb'.repeat(32)}` }));
  vi.mocked(createHistoryPort).mockReturnValue({ getLatestHeader: latest } as unknown as HistoryPort);
  const bridge = createScopedEthereumBridge({ context, rpc, resolveVerified: () => current });
  return { bridge, latest, sendTransaction, advance: () => { epoch++; },
    changeManifest: () => { current = { ...verified, manifest: { ...manifest, chainId: 1 } } as VerifiedDeployment; } };
}

function submission(kind: 0 | 1 | 2, outputs: unknown[] = []): PublicSubmission {
  return { request: { kind, owner, outputs } } as unknown as PublicSubmission;
}

beforeEach(() => { vi.clearAllMocks(); });

it('guards history after a pending RPC read and a wallet epoch change', async () => {
  let complete!: (value: { number: bigint; hash: `0x${string}` }) => void;
  const { bridge, advance, latest } = fixture();
  latest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const pending = bridge.history.getLatestHeader();
  advance();
  complete({ number: 3n, hash: `0x${'bb'.repeat(32)}` });
  await expect(pending).rejects.toThrow('SCOPE_CHANGED');
  expect(latest).toHaveBeenCalledOnce();
});

it('rejects a changed verified manifest before reading history', async () => {
  const { bridge, changeManifest, latest } = fixture();
  changeManifest();
  await expect(bridge.history.getLatestHeader()).rejects.toThrow('SCOPE_CHANGED');
  expect(latest).not.toHaveBeenCalled();
});

it('never sends Pay or partial Withdraw to the Pool submitter', async () => {
  const { bridge } = fixture();
  await expect(bridge.submitDeposit(submission(1))).rejects.toThrow('INVALID_POOL_SUBMISSION');
  await expect(bridge.submitFullWithdraw(submission(2, [{}]))).rejects.toThrow('INVALID_POOL_SUBMISSION');
  expect(submitPublicOperation).not.toHaveBeenCalled();
});

it('uses the captured wallet for a Deposit and preserves an unknown transaction result', async () => {
  const { bridge, sendTransaction } = fixture();
  vi.mocked(submitPublicOperation).mockImplementationOnce(async (_verified, _history, wallet, account, sent) => {
    expect(account.toLowerCase()).toBe(owner.toLowerCase());
    expect(sent.request.kind).toBe(0);
    expect(await wallet.getChainId()).toBe(31337);
    const hash = await wallet.sendTransaction({ account, to: pool as `0x${string}`, data: '0x1234',
      value: 2n, gas: 10n, nonce: 4, maxFeePerGas: 5n, maxPriorityFeePerGas: 1n });
    expect(hash).toBe(`0x${'aa'.repeat(32)}`);
    return { diagnostic: 'SUBMISSION_UNKNOWN', attempt: { outer: 'unconfirmed' } } as never;
  });
  const result = await bridge.submitDeposit(submission(0));
  expect(result.diagnostic).toBe('SUBMISSION_UNKNOWN');
  expect(result.scope).toEqual(scope);
  expect(result.epoch).toBe(7);
  expect(sendTransaction).toHaveBeenCalledWith({ from: owner, to: pool, data: '0x1234', value: '0x2',
    gas: '0xa', nonce: '0x4', maxFeePerGas: '0x5', maxPriorityFeePerGas: '0x1' });
});

it('passes a stale wallet response as unknown to the submission layer', async () => {
  const { bridge, sendTransaction } = fixture();
  sendTransaction.mockResolvedValueOnce({ value: `0x${'aa'.repeat(32)}`, scope, epoch: 8 });
  vi.mocked(submitPublicOperation).mockImplementationOnce(async (_verified, _history, wallet, account) => {
    try {
      await wallet.sendTransaction({ account, to: pool as `0x${string}`, data: '0x', value: 0n,
        gas: 1n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ message: 'SCOPE_CHANGED' });
      return { diagnostic: 'SUBMISSION_UNKNOWN', attempt: { outer: 'unconfirmed' } } as never;
    }
  });
  expect((await bridge.submitDeposit(submission(0))).diagnostic).toBe('SUBMISSION_UNKNOWN');
});

it('retains the original unknown attempt when the epoch changes during a possible broadcast', async () => {
  const { bridge, sendTransaction, advance } = fixture();
  sendTransaction.mockImplementationOnce(async () => {
    advance();
    throw new Error('response lost after possible broadcast');
  });
  const operationId = `0x${'ee'.repeat(32)}`;
  vi.mocked(submitPublicOperation).mockImplementationOnce(async (_verified, _history, wallet, account) => {
    try {
      await wallet.sendTransaction({ account, to: pool as `0x${string}`, data: '0x', value: 2n,
        gas: 1n, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      throw new Error('expected rejection');
    } catch {
      return { operationId, diagnostic: 'SUBMISSION_UNKNOWN', attempt: { outer: 'unconfirmed' },
        attempts: [{ outer: 'unconfirmed' }] } as never;
    }
  });
  const result = await bridge.submitDeposit(submission(0));
  expect(result).toMatchObject({ operationId, diagnostic: 'SUBMISSION_UNKNOWN',
    attempt: { outer: 'unconfirmed' }, attempts: [{ outer: 'unconfirmed' }], scope, epoch: 7 });
  expect(sendTransaction).toHaveBeenCalledOnce();
});

it('rejects a stale submission result with a transaction hash', async () => {
  const { bridge, advance } = fixture();
  vi.mocked(submitPublicOperation).mockImplementationOnce(async () => {
    advance();
    return { attempt: { outer: 'pending', txHash: `0x${'aa'.repeat(32)}` } } as never;
  });
  await expect(bridge.submitDeposit(submission(0))).rejects.toThrow('SCOPE_CHANGED');
});
