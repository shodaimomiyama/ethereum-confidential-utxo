import { beforeEach, expect, it, vi } from 'vitest';
import { prepareSubmission, verifyOperationAuthorization } from '@confidential-utxo/core';
import { createScopedEthereumBridge } from '../../src/live/ethereum.js';
import { createDepositCoordinator } from '../../src/live/deposit.js';
import type { LocalDraft } from '@confidential-utxo/core';
import type { OperationContext } from '../../src/live/operations.js';
import type { ScopedEthereumBridge } from '../../src/live/ethereum.js';
import type { VerifiedDeployment, RpcConnection } from '@confidential-utxo/ethereum';
import type { Scope } from '@confidential-utxo/uniswap';

const owner = `0x${'11'.repeat(20)}`;
const pool = `0x${'22'.repeat(20)}`;
const id = `0x${'aa'.repeat(32)}`;
const outputId = `0x${'bb'.repeat(32)}`;
const txHash = `0x${'cc'.repeat(32)}`;
const signature = `0x${'dd'.repeat(65)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const verified = { manifest: { chainId: 31337, pool: { address: pool } },
  context: { chainId: 31337n, pool, verifier: `0x${'33'.repeat(20)}`, deploymentBlock: 1n,
    parametersHash: `0x${'44'.repeat(32)}`, finalityMode: 'local-simulated' } } as VerifiedDeployment;
const draft = { context: verified.context, operationId: id, outputIds: [outputId],
  request: { kind: 0, owner, d: 10n, w: 0n, inputIds: [], outputs: [{}] }, signature: undefined,
  openings: [{ amount: 10n, blinding: 3n }], inputOpenings: [], balanceProof: {}, rangeProofs: [] } as unknown as LocalDraft;

vi.mock('@confidential-utxo/core', async importOriginal => ({ ...await importOriginal<object>(),
  operationId: vi.fn(() => id), authorizationTypedData: vi.fn(() => ({ message: { operationId: id } })),
  verifyOperationAuthorization: vi.fn(async () => undefined), prepareSubmission: vi.fn(async () => ({ status: 'ready', submission: { request: draft.request } })),
}));
vi.mock('../../src/live/ethereum.js', () => ({ createScopedEthereumBridge: vi.fn() }));

function fixture() {
  let epoch = 7;
  let current = verified;
  const typedSign = vi.fn(async () => ({ value: signature, scope, epoch: 7 }));
  const sendTransaction = vi.fn();
  const runCrypto = vi.fn(async (job: { jobId: string }) => ({ kind: 'result', jobKind: 'build-operation',
    jobId: job.jobId, scope, epoch: 7, value: structuredClone(draft) }));
  const context = { scope, epoch: 7, check: () => { if (epoch !== 7) throw new Error('SCOPE_CHANGED'); },
    typedSign, runCrypto, sendTransaction } as unknown as OperationContext;
  const submitDeposit = vi.fn(async (_submission: unknown) => ({ operationId: id, scope, epoch: 7,
    attempt: { outer: 'pending', txHash }, attempts: [{ outer: 'pending', txHash }] }));
  const history = {} as ScopedEthereumBridge['history'];
  vi.mocked(createScopedEthereumBridge).mockImplementation(deps => ({ history,
    submitDeposit: async (submission: Parameters<ScopedEthereumBridge['submitDeposit']>[0]) => {
      // Exercise the bridge's captured transaction callback when requested by a test.
      if (sendTransaction.getMockImplementation()) await deps.context.sendTransaction({});
      return submitDeposit(submission);
    },
  }) as unknown as ScopedEthereumBridge);
  const storage = { saveDraft: vi.fn(async () => 'saved' as const) };
  const keys = { getKey: vi.fn() };
  const coordinator = createDepositCoordinator({ context, rpc: {} as RpcConnection,
    resolveVerified: () => current, storage, keys });
  return { coordinator, typedSign, submitDeposit, sendTransaction, runCrypto, storage, keys,
    advance: () => { epoch++; }, changeDeployment: () => { current = { ...verified, manifest: { ...verified.manifest, chainId: 1 } } as VerifiedDeployment; } };
}

const recipient = {} as Parameters<ReturnType<typeof createDepositCoordinator>['prepare']>[1];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(prepareSubmission).mockResolvedValue({ status: 'ready',
  latest: { number: 2n, hash: id }, submission: { request: draft.request } } as never); });

it('builds Deposit in the scoped Worker and requires explicit authorization before signing or sending', async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  expect(f.runCrypto).toHaveBeenCalledWith(expect.objectContaining({ kind: 'build-operation',
    payload: { intent: { kind: 0, owner, amount: 10n, recipient }, context: verified.context, inputs: [] } }));
  expect(await f.coordinator.authorizeAndSubmit(prepared, false)).toMatchObject({ status: 'not-submitted',
    reason: 'authorization-required', operationId: id, outputIds: [outputId] });
  expect(f.typedSign).not.toHaveBeenCalled();
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(f.submitDeposit).not.toHaveBeenCalled();
});

it('refuses a rejected signature without saving or sending', async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  f.typedSign.mockRejectedValueOnce(new Error('user rejected'));
  expect(await f.coordinator.authorizeAndSubmit(prepared, true)).toMatchObject({ status: 'not-submitted', reason: 'signature-rejected' });
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(f.submitDeposit).not.toHaveBeenCalled();
});

it.each(['storage-unknown', 'unconfirmed'] as const)('never sends when the core gate returns %s', async status => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  vi.mocked(prepareSubmission).mockResolvedValueOnce({ status } as never);
  expect(await f.coordinator.authorizeAndSubmit(prepared, true)).toMatchObject({ status: 'not-submitted', reason: status });
  expect(f.submitDeposit).not.toHaveBeenCalled();
});

it('reports a hash as pending, retaining operation and output IDs without a success claim', async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  expect(await f.coordinator.authorizeAndSubmit(prepared, true)).toEqual({ status: 'pending', operationId: id, outputIds: [outputId], txHash });
  expect(verifyOperationAuthorization).toHaveBeenCalledWith(draft.context, id, owner, signature);
  expect(prepareSubmission).toHaveBeenCalledWith(expect.objectContaining({ signature }),
    expect.objectContaining({ storage: f.storage, keys: f.keys }));
  expect(f.submitDeposit).toHaveBeenCalledOnce();
});

it('retains IDs when broadcast outcome is unknown', async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  f.sendTransaction.mockRejectedValueOnce(new Error('wallet response lost after possible broadcast'));
  f.submitDeposit.mockResolvedValueOnce({ operationId: id, scope, epoch: 7,
    diagnostic: 'SUBMISSION_UNKNOWN', attempt: { outer: 'unconfirmed' }, attempts: [{ outer: 'unconfirmed' }] } as never);
  expect(await f.coordinator.authorizeAndSubmit(prepared, true)).toEqual({ status: 'unknown', operationId: id, outputIds: [outputId] });
  expect(f.sendTransaction).toHaveBeenCalledOnce();
});

it('blocks scope drift after signing and before the persistence gate', async () => {
  const f = fixture();
  const prepared = await f.coordinator.prepare(10n, recipient);
  f.typedSign.mockImplementationOnce(async () => { f.advance(); return { value: signature, scope, epoch: 7 }; });
  await expect(f.coordinator.authorizeAndSubmit(prepared, true)).rejects.toThrow('SCOPE_CHANGED');
  expect(prepareSubmission).not.toHaveBeenCalled();
  expect(f.submitDeposit).not.toHaveBeenCalled();
});

it('blocks a changed verified deployment before Worker preparation', async () => {
  const f = fixture();
  f.changeDeployment();
  await expect(f.coordinator.prepare(10n, recipient)).rejects.toThrow('SCOPE_CHANGED');
  expect(f.runCrypto).not.toHaveBeenCalled();
});
