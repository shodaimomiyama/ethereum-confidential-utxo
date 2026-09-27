import type { ParsedApiRequest, RewardRecord } from '@confidential-utxo/uniswap';
import type { ServiceContext, ServiceExtension } from '../extensions.js';
import { apiError, apiSuccess } from '../http.js';
import { getReward, listRewards, markRewardReceived, rewardLedgerVersion } from './store.js';
import { admitReward } from './store.js';
import { verifyRecipientInfo } from '@confidential-utxo/core';
import { M } from '@confidential-utxo/crypto';
import { rewardAvailability, setRewardAvailability } from './availability.js';
import { verifyFinalizedCancellation } from './production.js';

function wire(record: RewardRecord, context: ServiceContext): object {
  const availability = rewardAvailability(context.storage, context.recoveryGate, record.scope.deploymentId);
  return { ...record, amountWei: record.amountWei.toString(), availability: availability.reason };
}

function sameScope(request: ParsedApiRequest, context: ServiceContext): boolean {
  return context.scope !== undefined &&
    request.scope.deploymentId === context.scope.deploymentId &&
    request.scope.owner.toLowerCase() === context.scope.owner.toLowerCase();
}

export const rewardRoutes: ServiceExtension['routes'] = [
  {
    route: 'POST /v1/rewards',
    async handle(request: ParsedApiRequest, context: ServiceContext): Promise<Response> {
      if (context.scope === undefined || request.reward === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (!sameScope(request, context)) return apiError(403, 'SCOPE_MISMATCH');
      if (request.reward.amountWei < 1n || request.reward.amountWei > M) return apiError(400, 'INVALID_REQUEST');
      if (context.deployment === undefined) {
        return apiError(503, 'SERVICE_UNAVAILABLE');
      }
      const { recipientInfo } = request.reward;
      try {
        await verifyRecipientInfo(
          { chainId: BigInt(context.deployment.chainId), pool: context.deployment.pool as `0x${string}` },
          { chainId: BigInt(context.deployment.chainId), pool: context.deployment.pool as `0x${string}`,
            owner: recipientInfo.owner, receivePublicKey: recipientInfo.publicKey,
            receiptFormat: 1, recipientInfoVersion: 1, signature: recipientInfo.signature },
          request.scope.owner as `0x${string}`,
        );
      } catch { return apiError(400, 'INVALID_REQUEST'); }
      try {
        const known = admitReward(context.storage, request.reward);
        if (known.kind === 'same') return apiSuccess({ reward: wire(known.record, context) });
        if (known.kind === 'pending') return apiError(409, 'PENDING_REQUEST');
        if (!rewardAvailability(context.storage, context.recoveryGate, request.scope.deploymentId).accept) {
          return apiError(503, 'SERVICE_UNAVAILABLE');
        }
        if (context.readRewardFunds === undefined) return apiError(503, 'SERVICE_UNAVAILABLE');
        const expectedVersion = rewardLedgerVersion(context.storage, request.scope.deploymentId);
        let total: bigint | undefined;
        try { total = await context.readRewardFunds(request.scope.deploymentId); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        if (total === undefined) return apiError(503, 'SERVICE_UNAVAILABLE');
        const ended = context.storage.sql.exec<{ old_operation_id: string; operation_id: string;
          input_id: string; checkpoint_hash: string | null }>(`SELECT r.operation_id AS old_operation_id,
            c.operation_id, c.input_id, c.checkpoint_hash FROM reward_requests r
            JOIN reward_cancellations c ON c.deployment_id = r.deployment_id
              AND c.request_id = r.request_id
            WHERE r.deployment_id = ? AND r.status = 'ended-without-distribution'`,
        request.scope.deploymentId).toArray();
        if (ended.length > 0) {
          if (context.readRewardHistory === undefined) return apiError(503, 'SERVICE_UNAVAILABLE');
          const history = await context.readRewardHistory(request.scope.deploymentId);
          const point = await history.getFinalizedCheckpoint();
          if (point === null) return apiError(503, 'SERVICE_UNAVAILABLE');
          const observedContext = await history.getContext(point);
          if (!observedContext.complete || observedContext.blockHash.toLowerCase() !== point.hash.toLowerCase()) {
            return apiError(503, 'SERVICE_UNAVAILABLE');
          }
          for (const row of ended) {
            const valid = row.checkpoint_hash === null ? undefined
              : await verifyFinalizedCancellation(history, observedContext.value,
                row.old_operation_id, row.operation_id, row.input_id, row.checkpoint_hash);
            if (valid !== true) {
              if (valid === false) setRewardAvailability(context.storage,
                request.scope.deploymentId, 'restore-stopped');
              return apiError(503, 'SERVICE_UNAVAILABLE');
            }
          }
        }
        const result = admitReward(context.storage, request.reward, total, {
          expectedVersion,
          beforeWrite: () => {
            context.ensureWritable();
            if (!rewardAvailability(context.storage, context.recoveryGate,
              request.scope.deploymentId).accept) throw new Error('SERVICE_UNAVAILABLE');
          },
        });
        if (result.kind === 'insufficient') return apiError(422, 'INSUFFICIENT_FUNDS');
        if (result.kind === 'pending') return apiError(409, 'PENDING_REQUEST');
        if (result.kind === 'unknown') return apiError(503, 'SERVICE_UNAVAILABLE');
        await context.scheduleAlarm(Date.now());
        return apiSuccess({ reward: wire(result.record, context) });
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_CONFLICT') {
          return apiError(409, 'REQUEST_CONFLICT');
        }
        return apiError(503, 'SERVICE_UNAVAILABLE');
      }
    },
  },
  {
    route: 'POST /v1/rewards/{id}/received',
    async handle(request: ParsedApiRequest, context: ServiceContext): Promise<Response> {
      if (context.scope === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (!sameScope(request, context)) return apiError(403, 'SCOPE_MISMATCH');
      if (request.id === undefined || request.outputId === undefined || request.blockHash === undefined) {
        return apiError(400, 'INVALID_REQUEST');
      }
      if (getReward(context.storage, request.scope, request.id) === undefined) return apiError(404, 'NOT_FOUND');
      if (!rewardAvailability(context.storage, context.recoveryGate, request.scope.deploymentId).receive) {
        return apiError(503, 'SERVICE_UNAVAILABLE');
      }
      if (context.readRewardHistory === undefined) return apiError(503, 'SERVICE_UNAVAILABLE');
      try {
        const history = await context.readRewardHistory(request.scope.deploymentId);
        const updated = await markRewardReceived(context.storage, request.scope, request.id,
          request.outputId, request.blockHash, history, () => {
            context.ensureWritable();
            if (!rewardAvailability(context.storage, context.recoveryGate,
              request.scope.deploymentId).receive) throw new Error('SERVICE_UNAVAILABLE');
          });
        return apiSuccess({ reward: wire(updated, context) });
      } catch (error) {
        if (error instanceof Error && error.message === 'NOT_FOUND') return apiError(404, 'NOT_FOUND');
        if (error instanceof Error && error.message === 'NOT_FINALIZED') return apiError(409, 'REQUEST_CONFLICT');
        return apiError(503, 'SERVICE_UNAVAILABLE');
      }
    },
  },
  {
    route: 'GET /v1/rewards',
    handle(request: ParsedApiRequest, context: ServiceContext): Response {
      if (context.scope === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (!sameScope(request, context)) return apiError(403, 'SCOPE_MISMATCH');
      return apiSuccess({ rewards: listRewards(context.storage, request.scope).map((record) => wire(record, context)) });
    },
  },
  {
    route: 'GET /v1/rewards/{id}',
    handle(request: ParsedApiRequest, context: ServiceContext): Response {
      if (context.scope === undefined || request.id === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (!sameScope(request, context)) return apiError(403, 'SCOPE_MISMATCH');
      const found = getReward(context.storage, request.scope, request.id);
      return found === undefined ? apiError(404, 'NOT_FOUND') : apiSuccess({ reward: wire(found, context) });
    },
  },
];
