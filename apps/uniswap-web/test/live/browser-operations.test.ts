import { expect, it, vi } from 'vitest';
import type { Context, SyncResult } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import type { LiveOperationBindings } from '../../src/live/bootstrap.js';
import { createBrowserOperationDependencies } from '../../src/live/browser-operations.js';
import type { OperationContext } from '../../src/live/operations.js';
import type { PreparationDeployment } from '../../src/live/payment-preparation.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const scope = { deploymentId: 'local-v1', owner: address('1') } as Scope;
const deployment: PreparationDeployment = { chainId: 31337n, pool: address('2'), adapter: address('3'),
  token: address('4'), router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
const coreContext: Context = { chainId: 31337n, pool: deployment.pool, verifier: address('9'),
  parametersHash: hash('a'), deploymentBlock: 0n, finalityMode: 'local-simulated' };
const verified = { context: coreContext, manifest: { chainId: 31337, pool: { address: deployment.pool } } } as unknown as VerifiedDeployment;
const browser = { deploymentId: scope.deploymentId, chainId: 31337n, pool: deployment.pool,
  adapter: deployment.adapter, origin: 'https://wallet.example.test', siweUri: 'https://wallet.example.test/login' };
const rpc = { mode: 'local-simulated', policy: { chunkBlocks: 10n, minChunkBlocks: 1n,
  retries: 0, requestTimeoutMs: 1_000, overallTimeoutMs: 2_000 }, client: {} } as RpcConnection;

function state(stale = false): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true,
    network: true, key: true, faucet: false, gas: false }, utxos: [], selectedInput: {},
    operationCards: {}, operationActions: {}, publicEthWei: 0n, availablePrivateWei: 0n,
    pendingPrivateWei: 0n, isStale: stale, storageAvailability: 'healthy',
    cards: { reward: { phase: 'needs-preparation', input: {} }, pay: { phase: 'needs-preparation', input: {} },
      deposit: { phase: 'needs-preparation', input: {} }, withdraw: { phase: 'needs-preparation', input: {} } },
    operations: [], rewardRequests: [], allowedActions: [], reasons: {} };
}

function fixture() {
  let current = state();
  let liveVerified = verified;
  const bindings = { snapshot: () => current, resolveVerified: () => liveVerified,
    resolveDeployment: () => browser, rpc, http: {} as LiveOperationBindings['http'],
    auth: { isAuthenticated: () => true } as unknown as LiveOperationBindings['auth'],
    wallet: {} as LiveOperationBindings['wallet'] } satisfies LiveOperationBindings;
  const context = { scope, epoch: 1, check() {} } as OperationContext;
  const unused = () => { throw new Error('Not exercised by this test'); };
  const evaluateReady = vi.fn(async ({ view }: { view: ViewState }) => ({ cards: view.cards,
    allowedActions: ['edit:pay'], reasons: view.reasons, selectedInput: view.selectedInput }));
  const dependencies = {
    paymentDeployment: deployment, resolvePaymentDeployment: () => deployment,
    clock: { now: () => 100 }, refreshDecision: unused, currentDecision: unused,
    paymentRecovery: unused, paymentReconciliation: unused,
    evaluateReady, evaluateDraft: unused, recheck: unused, resumeOriginal: unused,
    retryAttempt: unused, receive: unused, indexedDb: null,
  } as Parameters<typeof createBrowserOperationDependencies>[1];
  return { bindings, context, dependencies, evaluateReady, publish: (value: ViewState) => { current = value; },
    replaceVerified: (value: VerifiedDeployment) => { liveVerified = value; } };
}

it('supplies scoped verified history and worker receipt keys to finalized sync', () => {
  const f = fixture();
  const composed = createBrowserOperationDependencies(f.bindings, f.dependencies);
  const source = composed.coreSync(scope, f.context, verified);
  expect(source.deploymentId).toBe(scope.deploymentId);
  expect(source.coreContext).toEqual(coreContext);
  expect(source.history.getFinalizedCheckpoint).toBeTypeOf('function');
  expect(source.keys.openReceipt).toBeTypeOf('function');
});

it('reuses a complete core snapshot only for the same healthy scope and epoch', async () => {
  const f = fixture();
  const composed = createBrowserOperationDependencies(f.bindings, f.dependencies);
  const core: Extract<SyncResult, { status: 'complete' }> = { status: 'complete',
    checkpoint: { number: 1n, hash: hash('b'), mode: 'local-simulated' },
    utxos: [], receiptFailures: [], availableWei: 0n };
  const view = state();
  await composed.recomputeReady!({ scope, context: f.context, core,
    recovered: { records: [], finalized: { outputs: [] }, availability: 'healthy', allowedActions: [] }, view });
  expect(composed.coreSync(scope, f.context, verified).previousCore).toEqual(core);
  expect(composed.coreSync(scope, { ...f.context, epoch: 2 }, verified).previousCore).toBeUndefined();
  f.publish(state(true));
  expect(composed.coreSync(scope, f.context, verified).previousCore).toBeUndefined();
  f.publish(state());
  expect(composed.coreSync(scope, f.context, verified).previousCore).toBeUndefined();
});

it('accepts the first healthy sync decision before the controller publishes it', async () => {
  const f = fixture();
  f.publish({ ...state(true), storageAvailability: 'unavailable' });
  const composed = createBrowserOperationDependencies(f.bindings, f.dependencies);
  const core: Extract<SyncResult, { status: 'complete' }> = { status: 'complete',
    checkpoint: { number: 1n, hash: hash('b'), mode: 'local-simulated' },
    utxos: [], receiptFailures: [], availableWei: 0n };
  await expect(composed.recomputeReady!({ scope, context: f.context, core,
    recovered: { records: [], finalized: { outputs: [] }, availability: 'healthy', allowedActions: [] },
    view: state() })).resolves.toMatchObject({ allowedActions: ['edit:pay'] });
});

it('rejects deployment mutation and clears cached core across A to B to A', async () => {
  const f = fixture();
  const composed = createBrowserOperationDependencies(f.bindings, f.dependencies);
  const core: Extract<SyncResult, { status: 'complete' }> = { status: 'complete',
    checkpoint: { number: 1n, hash: hash('b'), mode: 'local-simulated' },
    utxos: [], receiptFailures: [], availableWei: 0n };
  await composed.recomputeReady!({ scope, context: f.context, core,
    recovered: { records: [], finalized: { outputs: [] }, availability: 'healthy', allowedActions: [] }, view: state() });
  f.publish({ ...state(), scope: { ...scope, owner: address('a') } });
  expect(() => composed.coreSync(scope, f.context, verified)).toThrow('SCOPE_CHANGED');
  f.publish(state());
  expect(composed.coreSync(scope, f.context, verified).previousCore).toBeUndefined();
  f.replaceVerified({ ...verified, context: { ...verified.context, pool: address('b') } });
  expect(() => composed.coreSync(scope, f.context, verified)).toThrow('SCOPE_CHANGED');
});
