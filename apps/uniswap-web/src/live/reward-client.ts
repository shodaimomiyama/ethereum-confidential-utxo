import { recipientInfoTypedData, verifyRecipientInfo } from '@confidential-utxo/core';
import type { BrowserDeployment, createDeploymentResolver } from './deployment.js';
import { parseBytes32, type Bytes32, type RequestId, type RewardRecord, type Scope } from '@confidential-utxo/uniswap';
import { HttpFailure, sameScope, type HttpClient } from './http.js';
import type { OperationContext } from './operations.js';

export class RewardRequestUncertain extends Error {
  constructor(readonly requestId: RequestId, cause: unknown) {
    super('REWARD_REQUEST_UNCERTAIN', { cause });
    this.name = 'RewardRequestUncertain';
  }
}

export interface ScopedRewardDependencies {
  readonly context: OperationContext;
  /** This client must carry the user's authenticated, same-origin session. */
  readonly http: HttpClient;
  readonly auth: { isAuthenticated(scope: Scope): boolean };
  /** Use the resolver returned by createDeploymentResolver after on-chain verification. */
  readonly resolveDeployment: ReturnType<typeof createDeploymentResolver>;
}

export interface ScopedRewardClient {
  request(amountWei: string, requestId: RequestId): Promise<RewardRecord>;
  recheck(requestId: RequestId): Promise<RewardRecord>;
  list(): Promise<readonly RewardRecord[]>;
}

const idPattern = /^0x[0-9a-fA-F]{64}$/;
const amountPattern = /^[1-9][0-9]*$/;

function sameDeployment(a: BrowserDeployment, b: BrowserDeployment): boolean {
  return a.deploymentId === b.deploymentId && a.chainId === b.chainId
    && a.pool.toLowerCase() === b.pool.toLowerCase()
    && a.adapter.toLowerCase() === b.adapter.toLowerCase()
    && a.origin === b.origin && a.siweUri === b.siweUri;
}

/** A single captured action. A caller retains its requestId when POST outcome is unknown. */
export function createScopedRewardClient(deps: ScopedRewardDependencies): ScopedRewardClient {
  const { context } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const resolved = deps.resolveDeployment(scope.deploymentId);
  if (!resolved) throw new Error('SCOPE_CHANGED');
  const deployment = { ...resolved };

  function check(): void {
    context.check();
    const current = deps.resolveDeployment(scope.deploymentId);
    if (context.epoch !== epoch || !sameScope(context.scope, scope)
      || !current || !sameDeployment(deployment, current)) throw new Error('SCOPE_CHANGED');
    if (!deps.auth.isAuthenticated(scope)) throw new Error('UNAUTHENTICATED');
  }

  function validId(value: string): asserts value is RequestId {
    if (!idPattern.test(value)) throw new Error('INVALID_REQUEST_ID');
  }

  check();
  return {
    async request(amountWei, requestId) {
      check(); validId(requestId);
      if (!amountPattern.test(amountWei) || BigInt(amountWei) >= (1n << 256n)) throw new Error('INVALID_DECIMAL');
      const unsigned = { ...context.recipientInfo() };
      check();
      const typed = recipientInfoTypedData(
        { chainId: deployment.chainId, pool: deployment.pool }, unsigned, scope.owner,
      );
      const signed = await context.typedSign(typed, 'recipient-info');
      check();
      if (signed.epoch !== epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED');
      const signature = signed.value as `0x${string}`;
      await verifyRecipientInfo({ chainId: deployment.chainId, pool: deployment.pool }, { ...unsigned, signature }, scope.owner);
      check();
      // #53 deliberately carries only these three recipient fields. The chain and
      // pool are bound inside the verified EIP-712 signature and deployment scope.
      const recipientInfo = { owner: unsigned.owner, publicKey: parseBytes32(unsigned.receivePublicKey, 'recipientInfo.publicKey'), signature };
      let reply: Awaited<ReturnType<HttpClient['call']>>;
      try {
        reply = await deps.http.call('POST /v1/rewards', { scope, body: { scope, requestId, amountWei, recipientInfo } });
      } catch (error) {
        if (error instanceof HttpFailure && error.kind === 'api') throw error;
        throw new RewardRequestUncertain(requestId, error);
      }
      try {
        check();
        if (!('reward' in reply) || reply.reward.requestId.toLowerCase() !== requestId.toLowerCase()
          || !sameScope(reply.reward.scope, scope) || reply.reward.amountWei !== BigInt(amountWei)
          || reply.reward.recipientInfo.owner.toLowerCase() !== recipientInfo.owner.toLowerCase()
          || reply.reward.recipientInfo.publicKey.toLowerCase() !== recipientInfo.publicKey.toLowerCase()
          || reply.reward.recipientInfo.signature.toLowerCase() !== signature.toLowerCase()) throw new Error('SCOPE_CHANGED');
        return reply.reward;
      } catch (error) {
        throw new RewardRequestUncertain(requestId, error);
      }
    },
    async recheck(requestId) {
      check(); validId(requestId);
      const response = await deps.http.call('GET /v1/rewards/{id}', { scope, id: requestId as unknown as Bytes32 });
      check();
      if (response.reward.requestId.toLowerCase() !== requestId.toLowerCase()
        || !sameScope(response.reward.scope, scope)) throw new Error('SCOPE_CHANGED');
      return response.reward;
    },
    async list() {
      check();
      const response = await deps.http.call('GET /v1/rewards', { scope });
      check();
      if (response.rewards.some(reward => !sameScope(reward.scope, scope))) throw new Error('SCOPE_CHANGED');
      return response.rewards;
    },
  };
}
