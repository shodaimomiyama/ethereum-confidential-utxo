import { describe, expect, it } from 'vitest';
import type { OperationId, Scope } from '@confidential-utxo/uniswap';
import type { UiAction, ViewState } from '../../src/contracts/index.js';
import { createLiveController, type LiveControllerDependencies, type OperationPort, type OperationResult, type PreparedOperation } from '../../src/live/index.js';
import { projectConnectionChange } from '../../src/live/operations.js';
import type { CryptoJob } from '../../src/live/worker-protocol.js';
import type { WalletEvent, WalletPort } from '../../src/live/wallet.js';

const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
const other = { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope;
const operationId = `0x${'33'.repeat(32)}` as OperationId;
function view(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true, network: true, key: true, faucet: true, gas: true },
    utxos: [], selectedInput: {}, operationCards: {}, operationActions: {}, publicEthWei: 0n, availablePrivateWei: 0n, pendingPrivateWei: 0n,
    isStale: false, storageAvailability: 'healthy', operations: [], rewardRequests: [], reasons: {},
    cards: Object.fromEntries(['pay', 'withdraw', 'reward', 'deposit'].map(card => [card, { phase: 'ready', input: {} }])) as ViewState['cards'],
    allowedActions: ['start:pay', 'start:withdraw', 'start:deposit', 'start:reward', 'connect', 'prepare-key', 'authenticate', 'switch-network', 'resync', 'edit:pay', 'new-operation:pay', 'confirm-terms', 'switch-scope', 'recheck-reward'] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  const calls: string[] = [];
  const listeners = new Set<(event: WalletEvent) => void>();
  let connection: WalletEvent = { scope, epoch: 0 };
  let latest = view();
  const decision = (): OperationResult => ({ scope: latest.scope, view: latest });
  const prepared = (card: 'pay' | 'withdraw' | 'deposit'): PreparedOperation => ({ scope, card, operationId, handle: {},
    proof: { jobId: `${card}-proof`, payload: {} as never } });
  const wallet = { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect: async () => { calls.push('connect'); return { scope, epoch: connection.epoch, value: scope }; },
    switchChain: async () => ({ scope, epoch: connection.epoch, value: undefined }),
    typedSign: async () => { calls.push('sign'); return { scope, epoch: connection.epoch, value: '0x01' }; },
    personalSign: async () => { calls.push('personal-sign'); return { scope, epoch: connection.epoch, value: '0x01' }; },
    sendTransaction: async () => ({ scope, epoch: connection.epoch, value: '0x02' }), dispose: () => { calls.push('wallet-dispose'); },
  } satisfies WalletPort;
  const operations: OperationPort = {
    connectionChanged: (previous, event) => ({ ...previous, currentScope: event.scope, connection: event.scope ? 'connected' : 'disconnected' }),
    switchScope: (previous, next) => { latest = { ...previous, scope: next }; return latest; },
    transition: async (_scope, action, previous) => { calls.push(action.type); latest = previous; return decision(); },
    preparePay: async () => { calls.push('preparePay'); return prepared('pay'); },
    prepareWithdraw: async () => { calls.push('prepareWithdraw'); return prepared('withdraw'); },
    prepareDeposit: async () => { calls.push('prepareDeposit'); return prepared('deposit'); },
    completePreparation: async (value) => { calls.push('completePreparation'); return { kind: 'prepared', prepared: value }; },
    authorize: async (_prepared, context) => { calls.push('authorize'); await context.typedSign({}, 'pool-authorization'); return decision(); },
    syncFinalized: async () => { calls.push('sync'); return decision(); },
    startReward: async () => { calls.push('reward'); latest = { ...latest, rewardRequests: [{ requestId: 'request' as never, status: 'pending' }] }; return decision(); },
    recheckReward: async (_scope, request) => { calls.push(`reward:${request}`); return decision(); },
    recheck: async () => { calls.push('recheck'); return decision(); },
    resumeOriginal: async () => { calls.push('resume'); return decision(); },
    retryAttempt: async () => { calls.push('retry'); return decision(); },
    receive: async () => { calls.push('receive'); return decision(); },
    failure: (_scope, _action, previous) => ({ scope: previous.scope, view: previous }),
  };
  const deps: { -readonly [K in keyof LiveControllerDependencies]: LiveControllerDependencies[K] } = { initialState: latest, connection: () => connection, wallet, operations,
    resolveDeployment: () => ({ chainId: 1n, pool: `0x${'44'.repeat(20)}` }),
    worker: { run: async (job: CryptoJob) => { calls.push('prove'); return { kind: 'result', jobKind: job.kind, jobId: job.jobId, scope: job.scope, epoch: job.epoch, value: {} }; }, setContext() {}, cancel() { calls.push('cancel'); }, dispose() { calls.push('worker-dispose'); } } as never,
    auth: { authenticate: async () => { calls.push('authenticate'); }, isAuthenticated: () => true, invalidate() {}, dispose() {} },
    createKeySession: () => ({ prepare: async () => { calls.push('prepare-key'); }, dispose() {}, recordKey: () => ({} as CryptoKey), recipientPublicKey: () => new Uint8Array(32), recipientInfo: () => ({} as never), recipientPrivateKeyForWorker: () => new Uint8Array(32) }),
  };
  return { calls, operations, deps, listeners, decision, prepared, change(next?: Scope) { connection = { epoch: connection.epoch + 1, ...(next ? { scope: next } : {}) }; for (const listener of listeners) listener(connection); } };
}

describe('live coordinator', () => {
  it('adopts the first connected owner without retaining the disconnected placeholder scope', async () => {
    const f = setup();
    f.change();
    f.deps.initialState = { ...view(), connection: 'disconnected', currentScope: undefined,
      preparation: { wallet: false, network: false, key: false, faucet: false, gas: false },
      isStale: true, storageAvailability: 'unavailable', allowedActions: ['connect'] };
    f.operations.connectionChanged = projectConnectionChange;
    f.operations.transition = async (connectedScope, _action, previous) => ({ scope: connectedScope, view: previous });
    f.deps.wallet.connect = async () => {
      f.change(other);
      return { scope: other, epoch: f.deps.connection().epoch, value: other };
    };
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'connect' })).toEqual({ kind: 'accepted' });
    expect(controller.snapshot().scope).toEqual(other);
    expect(controller.snapshot().preparation.key).toBe(false);
  });
  it.each(['pay', 'withdraw', 'deposit'] as const)('prepares and proves %s before entering published authorization', async card => {
    const f = setup(); const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'start', card })).toEqual({ kind: 'accepted' });
    expect(f.calls).toEqual([`prepare${card[0]!.toUpperCase()}${card.slice(1)}`, 'prove', 'completePreparation', 'authorize', 'sign']);
  });
  it('serializes actions and rechecks the same reward request on duplicate start', async () => {
    const f = setup(); const controller = createLiveController(f.deps);
    await Promise.all([controller.dispatch({ type: 'start', card: 'reward' }), controller.dispatch({ type: 'start', card: 'reward' })]);
    expect(f.calls).toEqual(['reward', 'reward:request']);
  });
  it.each(['received', 'ended-without-distribution'] as const)('starts a fresh same-amount reward after %s', async status => {
    const f = setup(); f.deps.initialState = { ...view(), rewardRequests: [{ requestId: 'old-request' as never, status }], cards: { ...view().cards, reward: { phase: 'complete', input: { amount: '1' } } } };
    let input: Readonly<Record<string, string>> | undefined; const start = f.operations.startReward;
    f.operations.startReward = async (...args) => { input = args[1]; return start(...args); };
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'start', card: 'reward' })).toEqual({ kind: 'accepted' });
    expect(f.calls).toEqual(['reward']); expect(input).toEqual({ amount: '1' });
  });
  it.each(['disconnected', 'wrong-network'] as const)('allows draft editing while %s without enabling wallet effects', async mode => {
    const f = setup(); f.change(); f.deps.initialState = { ...view(), connection: mode === 'disconnected' ? 'disconnected' : 'connected', currentScope: undefined, preparation: { ...view().preparation, network: false } };
    f.operations.transition = async (_scope, action, previous, context) => {
      context.check(); expect(() => context.recordKey()).toThrow();
      await expect(context.typedSign({}, 'pool-authorization')).rejects.toThrow('SCOPE_CHANGED');
      return { scope, view: { ...previous, cards: { ...previous.cards, pay: { ...previous.cards.pay, input: action.type === 'edit' ? { [action.field]: action.value } : {} } } } };
    };
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '2' })).toEqual({ kind: 'accepted' });
    expect(controller.snapshot().cards.pay.input.amount).toBe('2'); expect(f.calls).not.toContain('sign');
  });
  it.each(['chain', 'pool'] as const)('invalidates prepared keys when the manifest %s changes between actions', async field => {
    const f = setup(); const location = { chainId: 1n, pool: `0x${'44'.repeat(20)}` as `0x${string}` }; f.deps.resolveDeployment = () => location;
    let disposed = 0; let keyReads = 0; const create = f.deps.createKeySession;
    f.deps.createKeySession = connection => ({ ...create(connection), dispose() { disposed++; }, recordKey() { keyReads++; return {} as CryptoKey; } });
    f.operations.startReward = async (_scope, _input, context) => { context.recordKey(); return f.decision(); };
    const controller = createLiveController(f.deps); await controller.dispatch({ type: 'prepare-key' });
    if (field === 'chain') location.chainId = 2n; else location.pool = `0x${'55'.repeat(20)}`;
    expect((await controller.dispatch({ type: 'start', card: 'reward' })).kind).toBe('blocked');
    expect(disposed).toBe(1); expect(keyReads).toBe(0);
    await controller.dispatch({ type: 'prepare-key' });
    expect(await controller.dispatch({ type: 'start', card: 'reward' })).toEqual({ kind: 'accepted' }); expect(keyReads).toBe(1);
  });
  it('drops a pending Worker result after A→B→A and never signs', async () => {
    const f = setup(); const pending = deferred<any>(); f.deps.worker.run = () => pending.promise;
    const controller = createLiveController(f.deps); const result = controller.dispatch({ type: 'start', card: 'pay' });
    await new Promise(resolve => setTimeout(resolve, 0)); f.change(other); f.change(scope);
    pending.resolve({ kind: 'result', jobKind: 'prove', scope, epoch: 0, jobId: 'pay-proof', value: {} });
    expect(await result).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(f.calls).not.toContain('authorize');
  });
  it('drops actions queued before an account round trip', async () => {
    const f = setup(); const waiting = deferred<OperationResult>(); f.operations.syncFinalized = () => waiting.promise;
    const controller = createLiveController(f.deps); const one = controller.dispatch({ type: 'resync' }); const two = controller.dispatch({ type: 'start', card: 'deposit' });
    await new Promise(resolve => setTimeout(resolve, 0)); f.change(other); f.change(scope); waiting.resolve(f.decision());
    expect(await one).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(await two).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' });
    expect(f.calls).not.toContain('prepareDeposit');
  });
  it('returns changed terms after proof without authorization', async () => {
    const f = setup(); f.operations.completePreparation = async () => ({ kind: 'decision', result: { scope, view: { ...view(), cards: { ...view().cards, pay: { phase: 'confirm-terms', input: {}, reason: 'QUOTE_STALE' } } } } });
    const controller = createLiveController(f.deps); await controller.dispatch({ type: 'start', card: 'pay' });
    expect(controller.snapshot().cards.pay.phase).toBe('confirm-terms'); expect(f.calls).not.toContain('authorize');
  });
  it('awaits the delegated durable ACK before guarded authorization callbacks and retains the reservation on refusal', async () => {
    const f = setup(); const ack = deferred<void>(); let reserved = false;
    f.operations.authorize = async (_prepared, context) => { reserved = true; f.calls.push('save'); await ack.promise; context.check(); f.calls.push('signature-started-ack'); await context.typedSign({}, 'pool-authorization'); return f.decision(); };
    f.deps.wallet.typedSign = async () => { throw new Error('USER_REJECTED'); };
    const controller = createLiveController(f.deps); const work = controller.dispatch({ type: 'start', card: 'withdraw' });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.calls).not.toContain('signature-started-ack'); ack.resolve(); await work;
    expect(reserved).toBe(true); expect(f.calls).toContain('signature-started-ack');
  });
  it('checks generation inside a delegated wallet callback after its await', async () => {
    const f = setup(); const wait = deferred<void>();
    f.operations.authorize = async (_prepared, context) => { await wait.promise; await context.typedSign({}, 'pool-authorization'); return f.decision(); };
    const controller = createLiveController(f.deps); const work = controller.dispatch({ type: 'start', card: 'pay' });
    await new Promise(resolve => setTimeout(resolve, 0)); f.change(other); f.change(scope); wait.resolve();
    expect(await work).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(f.calls).not.toContain('sign');
  });
  it.each([['connect-wallet', 'connect'], ['prepare-recipient-key', 'prepare-key'], ['refresh-balances', 'sync']] as const)('accepts the #54 alias %s', async (type, expected) => {
    const f = setup(); const controller = createLiveController(f.deps); expect(await controller.dispatch({ type })).toEqual({ kind: 'accepted' }); expect(f.calls).toContain(expected);
  });
  it('does not authenticate while connecting or preparing keys', async () => {
    const f = setup(); const controller = createLiveController(f.deps);
    await controller.dispatch({ type: 'connect-wallet' }); await controller.dispatch({ type: 'prepare-recipient-key' }); expect(f.calls).not.toContain('authenticate');
    await controller.dispatch({ type: 'authenticate' }); expect(f.calls.filter(x => x === 'authenticate')).toHaveLength(2); // auth session plus view transition
  });
  it('creates recovery with the captured resync context after key preparation and authentication', async () => {
    const f = setup();
    const recovered = { records: [], finalized: { outputs: [] }, availability: 'healthy' as const, allowedActions: [] };
    let captured: unknown;
    f.deps.createRecovery = context => { captured = context; return { load: async () => recovered }; };
    f.operations.syncFinalized = async (_scope, context, result) => {
      expect(context).toBe(captured);
      expect(result).toBe(recovered);
      return f.decision();
    };
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'prepare-key' })).toEqual({ kind: 'accepted' });
    expect(await controller.dispatch({ type: 'resync' })).toEqual({ kind: 'accepted' });
    expect(captured).toBeDefined();
  });
  it('requires operation-scoped permissions and a matching scoped operation', async () => {
    const f = setup(); f.deps.initialState = { ...view(), allowedActions: ['recheck'], operationActions: {} };
    const controller = createLiveController(f.deps); expect(await controller.dispatch({ type: 'recheck', operationId })).toEqual({ kind: 'blocked', reason: 'NOT_ALLOWED' }); expect(f.calls).toEqual([]);
  });
  it.each(['recheck', 'resume-original', 'retry-attempt', 'acknowledge-receipt'] as const)('routes operation-scoped %s', async type => {
    const f = setup(); f.deps.initialState = { ...view(), operations: [{ scope, operationId, attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'none' }], operationActions: { [operationId]: [type] } };
    const controller = createLiveController(f.deps); expect(await controller.dispatch({ type, operationId })).toEqual({ kind: 'accepted' });
    expect(f.calls).toContain({ recheck: 'recheck', 'resume-original': 'resume', 'retry-attempt': 'retry', 'acknowledge-receipt': 'receive' }[type]);
  });
  it.each([{ type: 'edit', card: 'pay', field: 'amount', value: '1' }, { type: 'new-operation', card: 'pay' }, { type: 'confirm-terms', card: 'pay' }] satisfies UiAction[])('delegates $type without making business decisions', async action => {
    const f = setup(); const controller = createLiveController(f.deps); await controller.dispatch(action); expect(f.calls).toEqual([action.type]);
  });
  it('rejects an in-place manifest change while preparation is pending', async () => {
    const f = setup(); const location = { chainId: 1n, pool: `0x${'44'.repeat(20)}` as `0x${string}` }; const wait = deferred<PreparedOperation>();
    f.deps.resolveDeployment = () => location; f.operations.preparePay = () => wait.promise;
    const controller = createLiveController(f.deps); const work = controller.dispatch({ type: 'start', card: 'pay' });
    await new Promise(resolve => setTimeout(resolve, 0)); location.chainId = 2n; wait.resolve(f.prepared('pay'));
    expect(await work).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(f.calls).not.toContain('sign');
  });
  it('checks the initial connection before creating a key session', async () => {
    const f = setup(); f.change(other); let created = 0; const create = f.deps.createKeySession;
    f.deps.createKeySession = (connection) => { created++; return create(connection); };
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'prepare-key' })).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' });
    expect(created).toBe(0); expect(f.calls).not.toContain('personal-sign');
  });
  it('guards receipt Worker callbacks after an account round trip', async () => {
    const f = setup(); const wait = deferred<void>();
    f.deps.initialState = { ...view(), operations: [{ scope, operationId, attemptIds: [], txHashes: [], chainOutcome: 'finalized-success', receiptState: 'pending' }], operationActions: { [operationId]: ['acknowledge-receipt'] } };
    f.operations.receive = async (_scope, _id, context) => { await wait.promise; await context.runCrypto({ kind: 'receive', jobId: 'receipt', payload: {} as never }); return f.decision(); };
    const controller = createLiveController(f.deps); const work = controller.dispatch({ type: 'acknowledge-receipt', operationId });
    await new Promise(resolve => setTimeout(resolve, 0)); f.change(other); f.change(scope); wait.resolve();
    expect(await work).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(f.calls).not.toContain('prove');
    expect(controller.snapshot().operations[0]?.chainOutcome).toBe('finalized-success');
  });
  it('does not accept an old connect result after UI scope A→B→A', async () => {
    const f = setup(); const wait = deferred<Awaited<ReturnType<WalletPort['connect']>>>();
    f.deps.wallet.connect = () => wait.promise;
    const controller = createLiveController(f.deps); const work = controller.dispatch({ type: 'connect' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await controller.dispatch({ type: 'switch-scope', scope: other }); await controller.dispatch({ type: 'switch-scope', scope });
    wait.resolve({ scope, epoch: 0, value: scope });
    expect(await work).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' });
  });
  it('rejects a different operation returned by authorize', async () => {
    const f = setup(); f.operations.authorize = async () => ({ ...f.decision(), card: 'pay', operation: { scope, operationId: 'different' as OperationId, attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'none' } });
    const controller = createLiveController(f.deps);
    expect(await controller.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' });
  });
  it('keeps an unfinished reward even when the draft amount is changed', async () => {
    const f = setup(); f.deps.initialState = { ...view(), allowedActions: [...view().allowedActions, 'new-operation:reward'] };
    const start = f.operations.startReward; f.operations.startReward = async (...args) => { const result = await start(...args); return { ...result, view: { ...result.view, allowedActions: [...result.view.allowedActions, 'new-operation:reward'] } }; };
    const controller = createLiveController(f.deps); await controller.dispatch({ type: 'start', card: 'reward' });
    await controller.dispatch({ type: 'new-operation', card: 'reward' }); await controller.dispatch({ type: 'start', card: 'reward' });
    expect(f.calls.filter(call => call === 'reward')).toHaveLength(1); expect(f.calls).toContain('reward:request');
  });
  it('disposes subscriptions, rejects new actions, and suppresses in-flight notifications', async () => {
    const f = setup(); const waiting = deferred<OperationResult>(); f.operations.syncFinalized = () => waiting.promise;
    const controller = createLiveController(f.deps); let notifications = 0; controller.subscribe(() => { notifications++; });
    const work = controller.dispatch({ type: 'resync' }); await new Promise(resolve => setTimeout(resolve, 0)); controller.dispose(); waiting.resolve(f.decision());
    expect(await work).toEqual({ kind: 'blocked', reason: 'SCOPE_CHANGED' }); expect(f.listeners.size).toBe(0); expect(notifications).toBe(0);
    expect(await controller.dispatch({ type: 'resync' })).toEqual({ kind: 'blocked', reason: 'NOT_ALLOWED' });
  });
});
