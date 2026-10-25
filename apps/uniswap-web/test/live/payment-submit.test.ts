import { beforeEach, expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { OperationContext } from '../../src/live/operations.js';
import { createPaymentSubmit } from '../../src/live/payment-submit.js';

const id = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const owner = `0x${'11'.repeat(20)}` as `0x${string}`;
const poolAddress = `0x${'22'.repeat(20)}` as `0x${string}`;
const adapter = `0x${'33'.repeat(20)}` as `0x${string}`;
const scope = { deploymentId: 'local', owner } as Scope;
const opId = id('a');
const sig = `0x${'44'.repeat(65)}` as `0x${string}`;
const paySubmit = vi.fn();
const poolSubmit = vi.fn();
const makePay = vi.fn((_deps: unknown) => paySubmit);
const makePool = vi.fn((_deps: unknown) => ({ submitFullWithdraw: poolSubmit }));
let plain: Record<string, unknown>;

vi.mock('@confidential-utxo/core', async importOriginal => ({
  ...await importOriginal<typeof import('@confidential-utxo/core')>(), operationId: () => opId,
}));
vi.mock('../../src/live/payment-record.js', () => ({ decodePaymentPrivateRecord: () => plain }));
vi.mock('../../src/live/adapter-submit.js', () => ({ createAdapterSubmit: (deps: unknown) => makePay(deps) }));
vi.mock('../../src/live/ethereum.js', () => ({ createScopedEthereumBridge: (deps: unknown) => makePool(deps) }));

const location = { chainId: 31337n, pool: poolAddress, adapter };
const verified = { context: { chainId: 31337n, pool: poolAddress }, manifest: {} };
function fixture(kind: 'pay' | 'withdraw' = 'withdraw') {
  let epoch = 0;
  const record = { kind, scope, recordId: id('1'), inputId: id('2'), operationId: opId,
    contentHash: id('3'), encryptedBundle: {}, signatureStarted: true, attemptIds: [],
    ...(kind === 'pay' ? { paymentId: id('4'), deadline: 100n } : {}) };
  const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = record;
  const request = { kind: 2, owner, destination: owner, inputIds: [record.inputId], outputs: [], d: 0n, w: 10n };
  plain = { binding, operationId: opId, ...(kind === 'pay' ? { paymentId: id('4') } : {}),
    creationInputs: { operationId: opId, context: { chainId: 31337n, pool: poolAddress }, request,
      balanceProof: { Rx: 1n, Ry: 2n, s: 3n }, rangeProofs: [], openings: [{ amount: 10n, blinding: 7n }] } };
  const context = { scope, epoch: 0, check: () => { if (epoch) throw new Error('SCOPE_CHANGED'); },
    sendTransaction: vi.fn() } as unknown as OperationContext;
  const submit = createPaymentSubmit({ context, rpc: { mode: 'local-simulated' } as never,
    resolveVerified: () => verified as never, resolveDeployment: () => location as never,
    paymentTerms: () => ({} as never) });
  const prepared = { record, privateBytes: new Uint8Array([1]), poolAuthorization: {} } as never;
  const signatures = { pool: sig, ...(kind === 'pay' ? { payment: sig } : {}) };
  return { submit, prepared, signatures, context, drift: () => { epoch++; } };
}

beforeEach(() => { vi.clearAllMocks(); });

it('routes Pay only to the adapter with its prepared attempt', async () => {
  const f = fixture('pay');
  paySubmit.mockResolvedValueOnce({ kind: 'submitted', txHash: id('b') });
  expect(await f.submit(f.prepared, f.signatures, 'attempt' as never))
    .toEqual({ kind: 'submitted', txHash: id('b') });
  expect(paySubmit).toHaveBeenCalledWith(f.prepared, f.signatures, 'attempt');
  expect(makePool).not.toHaveBeenCalled();
});

it('projects only public Withdraw fields and maps a pending hash', async () => {
  const f = fixture();
  poolSubmit.mockResolvedValueOnce({ operationId: opId, scope, epoch: 0,
    attempt: { outer: 'pending', txHash: id('b') } });
  expect(await f.submit(f.prepared, f.signatures, 'attempt' as never))
    .toEqual({ kind: 'submitted', txHash: id('b') });
  const draft = plain.creationInputs as Record<string, unknown>;
  expect(poolSubmit).toHaveBeenCalledWith({ request: draft.request,
    balanceProof: draft.balanceProof, rangeProofs: [], signature: sig });
  expect(Object.keys(poolSubmit.mock.calls[0]![0])).toEqual(['request', 'balanceProof', 'rangeProofs', 'signature']);
  expect(makePay).not.toHaveBeenCalled();
});

it('keeps unconfirmed and stale post-send outcomes unknown', async () => {
  const f = fixture();
  poolSubmit.mockResolvedValueOnce({ operationId: opId, scope, epoch: 0, diagnostic: 'SUBMISSION_UNKNOWN',
    attempt: { outer: 'unconfirmed' } });
  expect(await f.submit(f.prepared, f.signatures, 'one' as never)).toEqual({ kind: 'unknown' });
  poolSubmit.mockImplementationOnce(async () => {
    f.drift();
    return { operationId: opId, scope, epoch: 0, attempt: { outer: 'pending', txHash: id('b') } };
  });
  expect(await f.submit(f.prepared, f.signatures, 'two' as never)).toEqual({ kind: 'unknown' });
});

it('rejects mismatched bindings and classifies presend failures', async () => {
  const f = fixture();
  (plain.binding as Record<string, unknown>).contentHash = id('f');
  expect(await f.submit(f.prepared, f.signatures, 'attempt' as never)).toEqual({ kind: 'not-submitted' });
  expect(makePool).not.toHaveBeenCalled();
  (plain.binding as Record<string, unknown>).contentHash = id('3');
  poolSubmit.mockRejectedValueOnce(new Error('preflight'));
  expect(await f.submit(f.prepared, f.signatures, 'attempt' as never)).toEqual({ kind: 'not-submitted' });
});

it('treats an exception after wallet invocation as unknown', async () => {
  const f = fixture();
  poolSubmit.mockImplementationOnce(async () => {
    const deps = makePool.mock.calls[0]![0] as { context: OperationContext };
    await deps.context.sendTransaction({} as never);
    throw new Error('response lost');
  });
  vi.mocked(f.context.sendTransaction).mockResolvedValueOnce({ scope, epoch: 0, value: id('b') });
  expect(await f.submit(f.prepared, f.signatures, 'attempt' as never)).toEqual({ kind: 'unknown' });
  expect(f.context.sendTransaction).toHaveBeenCalledOnce();
});
