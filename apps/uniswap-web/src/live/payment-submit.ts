import { operationId, type PublicSubmission } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, PaymentPorts, PaymentTerms, TxHash } from '@confidential-utxo/uniswap';
import { createAdapterSubmit } from './adapter-submit.js';
import { createScopedEthereumBridge } from './ethereum.js';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { decodePaymentPrivateRecord } from './payment-record.js';

export interface PaymentSubmitDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly resolveVerified: (id: OperationContext['scope']['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) =>
    { readonly chainId: bigint; readonly pool: Address; readonly adapter: Address } | undefined;
  readonly paymentTerms: (prepared: Parameters<PaymentPorts['submit']>[0]) => PaymentTerms;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): value is TxHash => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const signature = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);

/** Routes one already prepared #55 attempt through its pinned public submission path. */
export function createPaymentSubmit(deps: PaymentSubmitDependencies): PaymentPorts['submit'] {
  const { context, rpc } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const initial = deps.resolveVerified(scope.deploymentId);
  const location = deps.resolveDeployment(scope.deploymentId);
  if (!initial || !location || initial.context.chainId !== location.chainId ||
    !same(initial.context.pool, location.pool)) throw new Error('SCOPE_CHANGED');
  const verified = structuredClone(initial);
  const pinned = { ...location };
  const fingerprint = JSON.stringify(verified, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value);
  function check(): void {
    context.check();
    const current = deps.resolveVerified(scope.deploymentId);
    const currentLocation = deps.resolveDeployment(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current || !currentLocation ||
      JSON.stringify(current, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) !== fingerprint ||
      currentLocation.chainId !== pinned.chainId || !same(currentLocation.pool, pinned.pool) ||
      !same(currentLocation.adapter, pinned.adapter)) throw new Error('SCOPE_CHANGED');
  }
  check();
  return async (prepared, signatures, attemptId) => {
    let possibleSend = false;
    const trackedContext: OperationContext = { ...context, sendTransaction: async request => {
      possibleSend = true;
      return context.sendTransaction(request);
    } };
    try {
      check();
      const record = prepared.record;
      const plain = decodePaymentPrivateRecord(prepared.privateBytes);
      const draft = plain.creationInputs;
      const binding = plain.binding;
      if (!attemptId || !sameScope(record.scope, scope) || !sameScope(binding.scope, scope) ||
        record.kind !== binding.kind || !same(record.recordId, binding.recordId) ||
        !same(record.inputId, binding.inputId) || !same(record.contentHash, binding.contentHash) ||
        !same(record.operationId, binding.operationId) || !same(record.operationId, plain.operationId) ||
        !same(record.operationId, draft.operationId) || !same(draft.operationId, operationId(draft.context, draft.request)) ||
        !same(draft.request.owner, scope.owner) || draft.context.chainId !== pinned.chainId ||
        !same(draft.context.pool, pinned.pool) || !signature(signatures.pool) ||
        (plain.signatures && (plain.signatures.pool !== signatures.pool || plain.signatures.payment !== signatures.payment)) ||
        (record.kind === 'pay' && (binding.kind !== 'pay' || record.paymentId !== binding.paymentId ||
          record.deadline !== binding.deadline || plain.paymentId !== record.paymentId)) ||
        (record.kind === 'withdraw' && (binding.kind !== 'withdraw' || plain.paymentId !== undefined))) {
        return { kind: 'not-submitted' };
      }
      if (record.kind === 'pay') {
        const pay = createAdapterSubmit({ context: trackedContext, rpc, resolveDeployment: deps.resolveDeployment,
          paymentTerms: deps.paymentTerms });
        return await pay(prepared, signatures, attemptId);
      }
      if (signatures.payment !== undefined || draft.request.kind !== 2 || draft.request.outputs.length !== 0 ||
        draft.rangeProofs.length !== 0 || draft.request.d !== 0n || draft.request.w <= 0n ||
        !same(draft.request.destination, scope.owner)) return { kind: 'not-submitted' };
      const submission: PublicSubmission = {
        request: draft.request,
        balanceProof: draft.balanceProof,
        rangeProofs: draft.rangeProofs,
        signature: signatures.pool,
      };
      check();
      const pool = createScopedEthereumBridge({ context: trackedContext, rpc, resolveVerified: deps.resolveVerified });
      const result = await pool.submitFullWithdraw(submission);
      if (result.diagnostic === 'SUBMISSION_UNKNOWN' || result.attempt.outer === 'unconfirmed') return { kind: 'unknown' };
      check();
      if (!sameScope(result.scope, scope) || result.epoch !== epoch || !same(result.operationId, record.operationId) ||
        result.attempt.outer !== 'pending' || !hash(result.attempt.txHash)) return { kind: 'unknown' };
      return { kind: 'submitted', txHash: result.attempt.txHash };
    } catch {
      try { check(); } catch { return { kind: 'unknown' }; }
      return { kind: possibleSend ? 'unknown' : 'not-submitted' };
    }
  };
}
