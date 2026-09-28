import { operationId, verifyOperationAuthorization } from '@confidential-utxo/core';
import { uniswapPayAbi, type RpcConnection } from '@confidential-utxo/ethereum';
import { paymentAuthorizationTypedData, paymentDigest,
  type Address, type PaymentPorts, type PaymentTerms, type TxHash } from '@confidential-utxo/uniswap';
import { encodeFunctionData, recoverTypedDataAddress, type Hex } from 'viem';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import { decodePaymentPrivateRecord } from './payment-record.js';

// The deployment resolver must return only the site's verified, pinned manifest.
export interface AdapterSubmitDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) =>
    { readonly chainId: bigint; readonly pool: Address; readonly adapter: Address } | undefined;
  /** The preparer owns this immutable selection, including the confirmed quote. */
  readonly paymentTerms: (prepared: Parameters<PaymentPorts['submit']>[0]) => PaymentTerms;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
const signature = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
const positive = (value: bigint | undefined): value is bigint => typeof value === 'bigint' && value > 0n && value < (1n << 256n);
const quantity = (value: bigint | number): Hex => `0x${value.toString(16)}`;
function invalid(): never { throw new Error('INVALID_ADAPTER_SUBMISSION'); }

/** Only a scoped hash acknowledges sending. It is never chain success evidence. */
export function createAdapterSubmit(deps: AdapterSubmitDependencies): PaymentPorts['submit'] {
  const { context, rpc } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const initial = deps.resolveDeployment(scope.deploymentId);
  if (!initial || !address(initial.pool) || !address(initial.adapter) || initial.chainId <= 0n) invalid();
  const deployment = { ...initial };
  function check(): void {
    context.check();
    const current = deps.resolveDeployment(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current ||
      current.chainId !== deployment.chainId || !same(current.pool, deployment.pool) ||
      !same(current.adapter, deployment.adapter)) throw new Error('SCOPE_CHANGED');
  }
  check();
  return async (prepared, signatures, attemptId) => {
    let invoked = false;
    try {
      check();
      if (prepared.record.kind !== 'pay') return { kind: 'not-submitted' };
      const plain = decodePaymentPrivateRecord(prepared.privateBytes);
      const draft = plain.creationInputs;
      const terms = structuredClone(deps.paymentTerms(prepared));
      const passed = { ...signatures };
      check();
      const request = draft.request;
      if (!attemptId ||
        !sameScope(prepared.record.scope, scope) || !same(request.owner, scope.owner) ||
        !same(request.destination, deployment.adapter) || !same(draft.context.pool, deployment.pool) ||
        draft.context.chainId !== deployment.chainId || request.kind !== 2 || request.d !== 0n ||
        request.outputs.length !== 1 || request.inputIds.length !== 1 || draft.rangeProofs.length !== 1 ||
        !same(draft.operationId, operationId(draft.context, request)) ||
        !same(plain.operationId, draft.operationId) || !same(plain.paymentId ?? '', prepared.record.paymentId) ||
        !same(prepared.record.operationId, draft.operationId) || !same(terms.operationId, draft.operationId) ||
        !same(terms.owner, scope.owner) || terms.ethAmount !== request.w ||
        terms.deadline !== prepared.record.deadline ||
        !same(paymentDigest(terms, deployment.chainId, deployment.adapter), prepared.record.paymentId) ||
        !signature(passed.pool) || !signature(passed.payment) ||
        (plain.signatures && (plain.signatures.pool !== passed.pool || plain.signatures.payment !== passed.payment))) invalid();
      if (draft.rangeProofs.some(proof => proof.coords.length !== 10 || proof.scalars.length !== 5)) invalid();
      await verifyOperationAuthorization(draft.context, draft.operationId, scope.owner, passed.pool);
      check();
      const signer = await recoverTypedDataAddress({
        ...paymentAuthorizationTypedData(terms, deployment.chainId, deployment.adapter),
        signature: passed.payment,
      });
      check();
      if (!same(signer, scope.owner)) invalid();
      const withdrawal = { ...request, outputs: request.outputs.map(output => ({ owner: output.owner,
        Cx: output.commitment.x, Cy: output.commitment.y, receiptFormat: output.receiptFormat,
        packet: output.packet })) };
      const data = encodeFunctionData({ abi: uniswapPayAbi, functionName: 'pay', args: [
        withdrawal, draft.balanceProof, draft.rangeProofs as never, passed.pool, terms, passed.payment,
      ] });
      const owner = scope.owner as Address;
      const to = deployment.adapter;
      const value = 0n;
      if (BigInt(await rpc.client.getChainId()) !== deployment.chainId) invalid();
      check();
      const gas = await rpc.client.estimateGas({ account: owner, to, data, value });
      check();
      const fees = await rpc.client.estimateFeesPerGas();
      check();
      const nonce = await rpc.client.getTransactionCount({ address: owner, blockTag: 'pending' });
      check();
      const balance = await rpc.client.getBalance({ address: owner });
      check();
      const maxFeePerGas = fees.maxFeePerGas;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      if (!positive(gas) || !positive(maxFeePerGas) || !positive(maxPriorityFeePerGas) ||
        maxFeePerGas < maxPriorityFeePerGas || !Number.isSafeInteger(nonce) || nonce < 0 ||
        balance < gas * maxFeePerGas) invalid();
      check();
      invoked = true;
      const result = await context.sendTransaction({ from: owner, to, data, value: quantity(value),
        gas: quantity(gas), nonce: quantity(nonce), maxFeePerGas: quantity(maxFeePerGas),
        maxPriorityFeePerGas: quantity(maxPriorityFeePerGas) });
      check();
      if (!sameScope(result.scope, scope) || result.epoch !== epoch ||
        !/^0x[0-9a-fA-F]{64}$/.test(result.value)) return { kind: 'unknown' };
      return { kind: 'submitted', txHash: result.value as TxHash };
    } catch {
      const current = deps.resolveDeployment(scope.deploymentId);
      const drifted = context.epoch !== epoch || !sameScope(context.scope, scope) || !current ||
        current.chainId !== deployment.chainId || !same(current.pool, deployment.pool) ||
        !same(current.adapter, deployment.adapter);
      return { kind: invoked || drifted ? 'unknown' : 'not-submitted' };
    }
  };
}
