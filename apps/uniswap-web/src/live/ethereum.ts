import type { HistoryPort, PublicSubmission } from '@confidential-utxo/core';
import { createHistoryPort, submitPublicOperation,
  type RpcConnection, type SendOptions, type SendResult, type SubmissionWallet,
  type VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Hex } from 'viem';
import type { Scope } from '@confidential-utxo/uniswap';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';

export interface ScopedEthereumDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  /** Only deployments previously checked with verifyEthereumDeployment may be returned. */
  readonly resolveVerified: (id: OperationContext['scope']['deploymentId']) => VerifiedDeployment | undefined;
}

export interface ScopedEthereumBridge {
  readonly history: HistoryPort;
  /** Pool direct submission is limited to Deposit and full Withdraw. Pay uses the adapter. */
  submitDeposit(submission: PublicSubmission, options?: SendOptions): Promise<ScopedSendResult>;
  submitFullWithdraw(submission: PublicSubmission, options?: SendOptions): Promise<ScopedSendResult>;
}

export type ScopedSendResult = SendResult & { readonly scope: Scope; readonly epoch: number };

function fingerprint(verified: VerifiedDeployment): string {
  const { context, manifest } = verified;
  return JSON.stringify({ manifest, chainId: context.chainId.toString(), pool: context.pool.toLowerCase(),
    verifier: context.verifier.toLowerCase(), deploymentBlock: context.deploymentBlock.toString(),
    parametersHash: context.parametersHash.toLowerCase(), finalityMode: context.finalityMode });
}

function quantity(value: bigint | number): Hex {
  return `0x${value.toString(16)}`;
}

/** Binds #30's verified Ethereum ports to one controller action and its wallet epoch. */
export function createScopedEthereumBridge(deps: ScopedEthereumDependencies): ScopedEthereumBridge {
  const { context, rpc } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const initial = deps.resolveVerified(scope.deploymentId);
  if (!initial) throw new Error('SCOPE_CHANGED');
  const verified = structuredClone(initial);
  const expected = fingerprint(verified);
  function check(): void {
    context.check();
    const current = deps.resolveVerified(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current ||
      fingerprint(current) !== expected || rpc.mode !== verified.context.finalityMode ||
      verified.context.chainId !== BigInt(verified.manifest.chainId) ||
      verified.context.pool.toLowerCase() !== verified.manifest.pool.address.toLowerCase()) {
      throw new Error('SCOPE_CHANGED');
    }
  }
  async function guarded<T>(call: () => Promise<T>): Promise<T> {
    check();
    try { return await call(); } finally { check(); }
  }
  check();
  const source = createHistoryPort(verified, rpc.client, rpc.policy);
  const history: HistoryPort = {
    getFinalizedCheckpoint: () => guarded(() => source.getFinalizedCheckpoint()),
    getContext: point => guarded(() => source.getContext(point)),
    getCanonicalHeader: (number, point) => guarded(() => source.getCanonicalHeader(number, point)),
    getOperations: (fromBlock, point) => guarded(() => source.getOperations(fromBlock, point)),
    getUtxo: (id, point) => guarded(() => source.getUtxo(id, point)),
    getOperationSuccess: (id, point) => guarded(() => source.getOperationSuccess(id, point)),
    getLatestHeader: () => guarded(() => source.getLatestHeader()),
    getLatestUtxo: (id, point) => guarded(() => source.getLatestUtxo(id, point)),
    getLatestOperationSuccess: (id, point) => guarded(() => source.getLatestOperationSuccess(id, point)),
  };
  const owner = scope.owner as Address;
  const wallet: SubmissionWallet = {
    account: { address: owner, type: 'json-rpc' },
    getChainId: () => guarded(() => rpc.client.getChainId()),
    estimateGas: args => guarded(() => rpc.client.estimateGas(args)),
    estimateFeesPerGas: () => guarded(() => rpc.client.estimateFeesPerGas()),
    getBalance: args => guarded(() => rpc.client.getBalance(args)),
    getTransactionCount: args => guarded(() => rpc.client.getTransactionCount(args)),
    sendTransaction: async args => guarded(async () => {
      if (typeof args.account !== 'string' || args.account.toLowerCase() !== owner.toLowerCase() ||
        args.to.toLowerCase() !== verified.context.pool.toLowerCase()) throw new Error('SCOPE_CHANGED');
      const result = await context.sendTransaction({ from: owner, to: args.to, data: args.data,
        value: quantity(args.value), gas: quantity(args.gas), nonce: quantity(args.nonce),
        maxFeePerGas: quantity(args.maxFeePerGas), maxPriorityFeePerGas: quantity(args.maxPriorityFeePerGas) });
      check();
      if (!sameScope(result.scope, scope) || result.epoch !== epoch || !/^0x[0-9a-fA-F]{64}$/.test(result.value)) {
        throw new Error('SCOPE_CHANGED');
      }
      return result.value as Hex;
    }),
  };
  async function submit(submission: PublicSubmission, kind: 0 | 2, options: SendOptions = {}): Promise<ScopedSendResult> {
    check();
    if (submission.request.kind !== kind || submission.request.owner.toLowerCase() !== owner.toLowerCase() ||
      (kind === 2 && submission.request.outputs.length !== 0)) throw new Error('INVALID_POOL_SUBMISSION');
    const snapshot = structuredClone(submission);
    const selected: SendOptions = { ...options };
    let result: SendResult;
    try { result = await submitPublicOperation(verified, history, wallet, owner, snapshot, selected); }
    catch (error) { check(); throw error; }
    try { check(); }
    catch (error) {
      // The wallet may have broadcast before its response or epoch was lost. Keep
      // #30's unknown attempt attached to the original action, never a stale success.
      if (result.diagnostic !== 'SUBMISSION_UNKNOWN' || result.attempt.outer !== 'unconfirmed') throw error;
    }
    return { ...result, scope: { ...scope }, epoch };
  }
  return { history, submitDeposit: (submission, options) => submit(submission, 0, options),
    submitFullWithdraw: (submission, options) => submit(submission, 2, options) };
}
