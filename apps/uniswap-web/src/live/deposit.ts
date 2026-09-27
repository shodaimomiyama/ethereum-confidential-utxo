import { authorizationTypedData, operationId, prepareSubmission, verifyOperationAuthorization,
  type LocalDraft, type ReceiptKeyPort, type StoragePort } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { OperationId, Scope } from '@confidential-utxo/uniswap';
import type { Hex } from 'viem';
import type { RecipientInfo } from '@confidential-utxo/core';
import { createScopedEthereumBridge } from './ethereum.js';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';

export interface DepositDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly resolveVerified: (id: Scope['deploymentId']) => VerifiedDeployment | undefined;
  /** Must durably save the secret draft; there is currently no production web binding. */
  readonly storage: StoragePort;
  readonly keys: ReceiptKeyPort;
}

/** This handle contains a secret draft and must remain outside ViewState. */
export interface PreparedDeposit {
  readonly scope: Scope;
  readonly epoch: number;
  readonly operationId: OperationId;
  readonly outputIds: readonly Hex[];
  readonly amountWei: bigint;
  readonly draft: LocalDraft;
}

export type DepositResult =
  | { readonly status: 'pending'; readonly operationId: OperationId; readonly outputIds: readonly Hex[]; readonly txHash: Hex }
  | { readonly status: 'unknown'; readonly operationId: OperationId; readonly outputIds: readonly Hex[]; readonly txHash?: Hex }
  | { readonly status: 'not-submitted'; readonly operationId: OperationId; readonly outputIds: readonly Hex[];
      readonly reason: 'authorization-required' | 'signature-rejected' | 'invalid' | 'storage-unknown' |
        'unconfirmed' | 'executed' | 'conflict' | 'submission-rejected' };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const fingerprint = (value: VerifiedDeployment): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);

/** One captured Deposit action. A transaction hash is only a pending outer attempt. */
export function createDepositCoordinator(deps: DepositDependencies) {
  const { context } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const initial = deps.resolveVerified(scope.deploymentId);
  if (!initial) throw new Error('SCOPE_CHANGED');
  const verified = structuredClone(initial);
  const pinned = fingerprint(verified);
  function check(): void {
    context.check();
    const current = deps.resolveVerified(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current || fingerprint(current) !== pinned ||
      !same(verified.context.pool, verified.manifest.pool.address) ||
      verified.context.chainId !== BigInt(verified.manifest.chainId)) throw new Error('SCOPE_CHANGED');
  }
  check();
  function identity(prepared: PreparedDeposit) {
    return { operationId: prepared.operationId, outputIds: [...prepared.outputIds] };
  }
  function validate(prepared: PreparedDeposit): void {
    check();
    const draft = prepared.draft;
    if (!sameScope(prepared.scope, scope) || prepared.epoch !== epoch ||
      !same(prepared.operationId, draft.operationId) || !same(draft.operationId, operationId(draft.context, draft.request)) ||
      !same(draft.request.owner, scope.owner) || draft.request.kind !== 0 || draft.request.d !== prepared.amountWei ||
      draft.request.w !== 0n || draft.request.inputIds.length !== 0 || draft.request.outputs.length !== 1 ||
      draft.outputIds.length !== prepared.outputIds.length ||
      draft.outputIds.some((id, i) => !same(id, prepared.outputIds[i]!)) ||
      fingerprint({ ...verified, context: draft.context }) !== pinned) throw new Error('INVALID_DEPOSIT');
  }
  return {
    async prepare(amountWei: bigint, recipient: RecipientInfo): Promise<PreparedDeposit> {
      check();
      const jobId = crypto.randomUUID();
      const reply = await context.runCrypto({ kind: 'build-operation', jobId, payload: {
        intent: { kind: 0, owner: scope.owner, amount: amountWei, recipient }, context: verified.context, inputs: [],
      } });
      check();
      if (reply.kind !== 'result' || reply.jobKind !== 'build-operation' || reply.jobId !== jobId || reply.epoch !== epoch ||
        !sameScope(reply.scope, scope)) throw new Error('SCOPE_CHANGED');
      const draft = reply.value;
      const prepared: PreparedDeposit = { scope, epoch, operationId: draft.operationId as OperationId,
        outputIds: [...draft.outputIds], amountWei, draft };
      validate(prepared);
      return prepared;
    },
    async authorizeAndSubmit(prepared: PreparedDeposit, userAuthorized: boolean): Promise<DepositResult> {
      validate(prepared);
      const id = identity(prepared);
      if (userAuthorized !== true) return { status: 'not-submitted', ...id, reason: 'authorization-required' };
      const draft = structuredClone(prepared.draft);
      let signature: Hex;
      try {
        const typed = authorizationTypedData(draft.context, draft.request);
        const signed = await context.typedSign(typed, 'pool-authorization');
        check();
        if (signed.epoch !== epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED');
        signature = signed.value as Hex;
        await verifyOperationAuthorization(draft.context, draft.operationId, scope.owner, signature);
        check();
      } catch (error) {
        check();
        return { status: 'not-submitted', ...id, reason: 'signature-rejected' };
      }
      draft.signature = signature;
      let possibleSend = false;
      const tracked = createScopedEthereumBridge({ ...deps, context: { ...context,
        sendTransaction: async request => { possibleSend = true; return context.sendTransaction(request); },
      } });
      const gate = await prepareSubmission(draft, { history: tracked.history, storage: deps.storage, keys: deps.keys });
      check();
      if (gate.status !== 'ready') return { status: 'not-submitted', ...id, reason: gate.status };
      // #30 checks public ETH >= the Deposit value plus the maximum gas cost before wallet send.
      try {
        check();
        const result = await tracked.submitDeposit(gate.submission);
        if (!sameScope(result.scope, scope) || result.epoch !== epoch || !same(result.operationId, prepared.operationId)) {
          return { status: 'unknown', ...id };
        }
        if (result.diagnostic === 'SUBMISSION_UNKNOWN' || result.attempt.outer === 'unconfirmed') {
          return { status: 'unknown', ...id, ...(validHash(result.attempt.txHash) ? { txHash: result.attempt.txHash } : {}) };
        }
        check();
        if (result.attempt.outer === 'pending' && validHash(result.attempt.txHash)) {
          return { status: 'pending', ...id, txHash: result.attempt.txHash };
        }
        return { status: 'unknown', ...id, ...(validHash(result.attempt.txHash) ? { txHash: result.attempt.txHash } : {}) };
      } catch {
        try { check(); } catch { return { status: 'unknown', ...id }; }
        return possibleSend ? { status: 'unknown', ...id } : { status: 'not-submitted', ...id, reason: 'submission-rejected' };
      }
    },
  };
}
