import type { Address, Scope } from '@confidential-utxo/uniswap';
import { actionKey, isActionAllowed, type DispatchResult, type UiAction, type UiController, type ViewState } from '../contracts/index.js';
import type { AuthSession } from './auth.js';
import { sameScope } from './http.js';
import { recipientMessage, type KeySession } from './key-session.js';
import { mapDecisionToView, type OperationContext, type OperationPort, type OperationResult, type PreparedOperation } from './operations.js';
import type { Recovery } from './recovery.js';
import type { ResolveDeployment } from './scope.js';
import type { WalletEvent, WalletPort } from './wallet.js';
import type { CryptoWorkerClient } from './worker-client.js';

export interface LiveControllerDependencies {
  readonly initialState: ViewState;
  readonly wallet: WalletPort;
  readonly worker: Pick<CryptoWorkerClient, 'run' | 'setContext' | 'cancel' | 'dispose'>;
  readonly operations: OperationPort;
  readonly auth: AuthSession;
  readonly recovery?: Pick<Recovery, 'load'>;
  readonly resolveDeployment: ResolveDeployment;
  connection(): WalletEvent;
  createKeySession(connection: { readonly scope: Scope; readonly epoch: number }): KeySession;
}

const aliases = { 'connect-wallet': 'connect', 'prepare-recipient-key': 'prepare-key', 'refresh-balances': 'resync' } as const;
function canonical(action: UiAction): UiAction {
  return action.type in aliases ? { type: aliases[action.type as keyof typeof aliases] } : action;
}
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  }
  freeze(copy); return copy;
}
const blocked = (reason: 'NOT_ALLOWED' | 'SCOPE_CHANGED' | 'SERVICE_UNAVAILABLE'): DispatchResult => ({ kind: 'blocked', reason });

export function createLiveController(deps: LiveControllerDependencies): UiController {
  let state = immutable(deps.initialState);
  let connection = immutable(deps.connection());
  let generation = 0;
  let scopeGeneration = 0;
  let disposed = false;
  let keys: KeySession | undefined;
  let keyBinding: { scope: Scope; epoch: number; chainId: bigint; pool: string } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(value: ViewState) => void>();
  const publish = (next: ViewState): void => {
    state = immutable(next);
    for (const listener of listeners) { try { listener(state); } catch { /* A UI subscriber cannot interrupt an operation. */ } }
  };
  const clearKeys = (): void => { keys?.dispose(); keys = undefined; keyBinding = undefined; };
  const invalidate = (): void => { generation++; clearKeys(); deps.auth.invalidate(); deps.worker.cancel(); };
  const unsubscribe = deps.wallet.subscribe(event => {
    if (disposed) return;
    invalidate(); connection = immutable(event);
    publish(deps.operations.connectionChanged(state, connection));
  });
  const allowed = (action: UiAction): boolean => {
    if ('operationId' in action && !state.operations.some(operation => operation.operationId === action.operationId && sameScope(operation.scope, state.scope))) return false;
    if (action.type === 'recheck-reward' && !state.rewardRequests.some(request => request.requestId === action.requestId)) return false;
    if (isActionAllowed(state, action)) return true;
    for (const [alias, original] of Object.entries(aliases)) {
      if (action.type === original && state.allowedActions.includes(alias)) return true;
    }
    return false;
  };
  const context = (scope: Scope, captured: number, draft = false): OperationContext => {
    const epoch = connection.epoch;
    const location = deps.resolveDeployment(scope.deploymentId);
    const chainId = location?.chainId;
    const pool = location?.pool.toLowerCase();
    const checkDraft = (): void => {
      if (disposed || generation !== captured || deps.connection().epoch !== epoch || !sameScope(state.scope, scope)) throw new Error('SCOPE_CHANGED');
    };
    const check = (): void => {
      checkDraft();
      const current = deps.connection();
      const deployment = deps.resolveDeployment(scope.deploymentId);
      if (disposed || generation !== captured || current.epoch !== epoch || !sameScope(state.scope, scope)
        || !current.scope || !sameScope(current.scope, scope) || !location || !deployment
        || deployment.chainId !== chainId || deployment.pool.toLowerCase() !== pool) throw new Error('SCOPE_CHANGED');
    };
    const invalidateStaleKeys = (): void => {
      const current = deps.connection();
      const deployment = deps.resolveDeployment(scope.deploymentId);
      if (keys && (!keyBinding || !current.scope || !sameScope(current.scope, keyBinding.scope)
        || !sameScope(scope, keyBinding.scope) || current.epoch !== keyBinding.epoch
        || deployment?.chainId !== keyBinding.chainId || deployment.pool.toLowerCase() !== keyBinding.pool)) clearKeys();
    };
    invalidateStaleKeys();
    const currentKeys = (): KeySession => { check(); invalidateStaleKeys(); if (!keys) throw new Error('KEY_REQUIRED'); return keys; };
    return { scope: immutable(scope), epoch, check: draft ? checkDraft : check,
      recordKey: () => currentKeys().recordKey(),
      recipientInfo: () => currentKeys().recipientInfo(),
      recipientPrivateKeyForWorker: () => currentKeys().recipientPrivateKeyForWorker(),
      async runCrypto(job) {
        check(); deps.worker.setContext(scope, epoch);
        const reply = await deps.worker.run({ ...job, scope, epoch }); check();
        if (reply.epoch !== epoch || !sameScope(reply.scope, scope) || reply.jobId !== job.jobId || reply.jobKind !== job.kind) throw new Error('SCOPE_CHANGED');
        return reply;
      },
      async typedSign(data, purpose) {
        check(); const signed = await deps.wallet.typedSign(data, purpose); check();
        if (signed.epoch !== epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED'); return signed;
      },
      async sendTransaction(request) {
        check(); const sent = await deps.wallet.sendTransaction(request); check();
        if (sent.epoch !== epoch || !sameScope(sent.scope, scope)) throw new Error('SCOPE_CHANGED'); return sent;
      },
    };
  };
  const prepare = async (card: 'pay' | 'withdraw' | 'deposit', ctx: OperationContext): Promise<OperationResult> => {
    const method = card === 'pay' ? 'preparePay' : card === 'withdraw' ? 'prepareWithdraw' : 'prepareDeposit';
    const prepared = await deps.operations[method](ctx.scope, state.cards[card].input, ctx); ctx.check();
    const verify = (value: PreparedOperation): void => {
      if (!sameScope(value.scope, ctx.scope) || value.card !== card || value.operationId !== prepared.operationId) throw new Error('SCOPE_CHANGED');
    };
    verify(prepared);
    let proof;
    if (prepared.proof) {
      const reply = await ctx.runCrypto({ ...prepared.proof, kind: 'prove' }); ctx.check();
      if (reply.epoch !== ctx.epoch || !sameScope(reply.scope, ctx.scope) || reply.jobId !== prepared.proof.jobId || reply.jobKind !== 'prove') throw new Error('SCOPE_CHANGED');
      proof = reply.value;
    }
    const completed = await deps.operations.completePreparation(prepared, proof, ctx); ctx.check();
    if (completed.kind === 'decision') return completed.result;
    verify(completed.prepared);
    const result = await deps.operations.authorize(completed.prepared, ctx); ctx.check();
    if (result.operation && result.operation.operationId !== prepared.operationId) throw new Error('SCOPE_CHANGED');
    return result;
  };
  const run = async (action: Exclude<UiAction, { type: 'switch-scope' }>, ctx: OperationContext): Promise<OperationResult> => {
    const { scope } = ctx;
    if (action.type === 'prepare-key') {
      const location = immutable(deps.resolveDeployment(scope.deploymentId)!);
      const session = deps.createKeySession({ scope, epoch: ctx.epoch });
      try {
        ctx.check();
        const signed = await deps.wallet.personalSign(recipientMessage(location.chainId, location.pool as Address, scope.owner), 'recipient-key'); ctx.check();
        if (signed.epoch !== ctx.epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED');
        await session.prepare(signed.value as `0x${string}`); ctx.check(); clearKeys(); keys = session;
        keyBinding = { scope: immutable(scope), epoch: ctx.epoch, chainId: location.chainId, pool: location.pool.toLowerCase() };
      } catch (error) { session.dispose(); throw error; }
    } else if (action.type === 'authenticate') {
      await deps.auth.authenticate(scope); ctx.check();
    } else if (action.type === 'resync') {
      const recovered = deps.recovery && keys && deps.auth.isAuthenticated(scope) ? await deps.recovery.load(scope, ctx.recordKey()) : undefined;
      ctx.check(); return deps.operations.syncFinalized(scope, ctx, recovered);
    } else if (action.type === 'start') {
      if (action.card !== 'reward') return prepare(action.card, ctx);
      const existing = state.rewardRequests.filter(request => request.status !== 'received' && request.status !== 'ended-without-distribution').at(-1);
      return existing ? deps.operations.recheckReward(scope, existing.requestId, ctx) : deps.operations.startReward(scope, state.cards.reward.input, ctx);
    } else if (action.type === 'recheck-reward') return deps.operations.recheckReward(scope, action.requestId, ctx);
    else if (action.type === 'recheck') return deps.operations.recheck(scope, action.operationId, ctx);
    else if (action.type === 'resume-original') return deps.operations.resumeOriginal(scope, action.operationId, ctx);
    else if (action.type === 'retry-attempt') return deps.operations.retryAttempt(scope, action.operationId, ctx);
    else if (action.type === 'acknowledge-receipt') return deps.operations.receive(scope, action.operationId, ctx);
    return deps.operations.transition(scope, action, state, ctx);
  };
  return {
    snapshot: () => state,
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch(raw) {
      if (disposed) return Promise.resolve(blocked('NOT_ALLOWED'));
      const action = immutable(canonical(raw));
      if (action.type === 'switch-scope') {
        if (!allowed(action)) return Promise.resolve(blocked('NOT_ALLOWED'));
        // Scope selection is an invalidation barrier, like a wallet event, even while work is pending.
        scopeGeneration++;
        invalidate(); publish(deps.operations.switchScope(state, action.scope));
        return Promise.resolve({ kind: 'accepted' });
      }
      const captured = generation;
      const capturedScopeGeneration = scopeGeneration;
      const scope = immutable(state.scope);
      const task = async (): Promise<DispatchResult> => {
        if (disposed || captured !== generation || !sameScope(scope, state.scope)) return blocked('SCOPE_CHANGED');
        if (!allowed(action)) return { kind: 'blocked', reason: state.reasons[actionKey(action)] ?? 'NOT_ALLOWED' };
        let ctx = context(scope, captured, action.type === 'edit' || action.type === 'new-operation');
        try {
          if (action.type === 'connect' || action.type === 'switch-network') {
            const location = deps.resolveDeployment(scope.deploymentId);
            if (!location) return blocked('SERVICE_UNAVAILABLE');
            const reply = action.type === 'connect' ? await deps.wallet.connect() : await deps.wallet.switchChain(location.chainId);
            const current = deps.connection();
            if (disposed || scopeGeneration !== capturedScopeGeneration || !current.scope || current.epoch !== reply.epoch || !sameScope(current.scope, reply.scope) || !sameScope(scope, state.scope)) return blocked('SCOPE_CHANGED');
            connection = immutable(current); ctx = context(scope, generation);
          }
          ctx.check(); const result = await run(action, ctx); ctx.check();
          if ('operationId' in action && result.operation && result.operation.operationId !== action.operationId) throw new Error('SCOPE_CHANGED');
          const next = mapDecisionToView(state, result);
          publish(next); return { kind: 'accepted' };
        } catch (error) {
          try { ctx.check(); } catch { return blocked('SCOPE_CHANGED'); }
          if (error instanceof Error && error.message === 'SCOPE_CHANGED') return blocked('SCOPE_CHANGED');
          try { publish(mapDecisionToView(state, deps.operations.failure(scope, action, state, error))); }
          catch { return blocked('SERVICE_UNAVAILABLE'); }
          return blocked('SERVICE_UNAVAILABLE');
        }
      };
      const result = queue.then(task, task); queue = result; return result;
    },
    dispose() {
      if (disposed) return; disposed = true; invalidate(); unsubscribe(); listeners.clear();
      deps.auth.dispose(); deps.worker.dispose(); deps.wallet.dispose();
    },
  };
}
