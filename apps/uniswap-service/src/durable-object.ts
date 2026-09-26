import { DurableObject } from 'cloudflare:workers';
import { applyMigrations } from './schema.js';
import type { ServiceEnv } from './index.js';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { createChallenge, readSessionIdentity, verifyChallenge } from './auth.js';
import { parseDeploymentCatalog, resolveDeployment } from './config.js';
import { apiError, apiSuccess, BodyTooLarge, readLimitedJson } from './http.js';
import { listOperations, putOperation } from './store.js';
import { ensureWritable, getAvailability, resolveRecoveryGate } from './recovery.js';
import { getServiceExtensions, makeServiceContext } from './extensions.js';

export class UniswapServiceObject extends DurableObject<ServiceEnv> {
  constructor(ctx: DurableObjectState, env: ServiceEnv) {
    super(ctx, env);
    applyMigrations(ctx.storage, getServiceExtensions().flatMap((extension) => extension.migrations));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await readLimitedJson(request);
      const parsed = parseApiRequest(request.method, url.pathname + url.search, body);
      const config = resolveDeployment(parsed.scope.deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
      const recoveryGate = resolveRecoveryGate(this.env.RECOVERY_JSON, parsed.scope.deploymentId);
      const boundDeployment = await this.ctx.storage.get<string>('deploymentId');
      if (boundDeployment !== undefined && boundDeployment !== parsed.scope.deploymentId) return apiError(403, 'SCOPE_MISMATCH');
      if (boundDeployment === undefined) await this.ctx.storage.put('deploymentId', parsed.scope.deploymentId);
      if (url.origin !== config.origin || (request.method !== 'GET' && request.headers.get('origin') !== config.origin)) {
        return apiError(403, 'SCOPE_MISMATCH');
      }
      if (parsed.route === 'POST /v1/auth/challenge') {
        return apiSuccess(createChallenge(this.ctx.storage, parsed.scope, Date.now()));
      }
      if (parsed.route === 'POST /v1/auth/verify') {
        const result = await verifyChallenge(this.ctx.storage, config, parsed.scope,
          parsed.challengeId!, parsed.siweMessage!, parsed.signature!, Date.now());
        return apiSuccess({ sessionExpiresAt: result.expiresAt }, { 'Set-Cookie': result.cookie });
      }
      const identity = readSessionIdentity(this.ctx.storage, request.headers.get('cookie'), Date.now());
      if (identity === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (identity.deploymentId !== parsed.scope.deploymentId
        || identity.owner.toLowerCase() !== parsed.scope.owner.toLowerCase()) return apiError(403, 'SCOPE_MISMATCH');
      if (parsed.route === 'GET /v1/operations') {
        const page = listOperations(this.ctx.storage, parsed.scope, parsed.cursor);
        return apiSuccess({ availability: getAvailability(this.ctx.storage, recoveryGate), records: page.records.map((item) => ({
          ...item, scope: parsed.scope,
          record: { ...item.record, deadline: item.record.kind === 'pay' ? item.record.deadline.toString() : undefined },
        })), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      }
      if (parsed.route === 'PUT /v1/operations/{id}') {
        ensureWritable(this.ctx.storage, recoveryGate);
        const saved = await putOperation(this.ctx.storage, parsed.scope, parsed.record!, parsed.expectedRevision!, {
          readInput: async () => 'unknown',
        }, () => ensureWritable(this.ctx.storage, recoveryGate));
        return apiSuccess({ ...saved, scope: parsed.scope,
          record: { ...saved.record, deadline: saved.record.kind === 'pay' ? saved.record.deadline.toString() : undefined },
        });
      }
      for (const extension of getServiceExtensions()) {
        const route = extension.routes.find((handler) => handler.route === parsed.route);
        if (route !== undefined) {
          const context = makeServiceContext(this.ctx.storage, recoveryGate, parsed.scope);
          if (!parsed.route.startsWith('GET ')) context.ensureWritable();
          return await route.handle(parsed, context);
        }
      }
      return apiError(503, 'SERVICE_UNAVAILABLE');
    } catch (error) {
      if (error instanceof BodyTooLarge) return apiError(413, 'PAYLOAD_TOO_LARGE');
      if (error instanceof Error) {
        if (error.message === 'UNKNOWN_DEPLOYMENT') return apiError(503, 'SERVICE_UNAVAILABLE');
        if (error.message === 'CHALLENGE_USED') return apiError(401, 'CHALLENGE_USED');
        if (error.message === 'CHALLENGE_EXPIRED') return apiError(401, 'CHALLENGE_EXPIRED');
        if (error.message === 'UNAUTHENTICATED') return apiError(401, 'UNAUTHENTICATED');
        if (error.name === 'InvalidAddressError' || error.name === 'InvalidSiweMessageError') return apiError(401, 'UNAUTHENTICATED');
        if (error.message === 'SCOPE_MISMATCH') return apiError(403, 'SCOPE_MISMATCH');
        if (error.message === 'RESERVATION_CONFLICT') return apiError(409, 'RESERVATION_CONFLICT');
        if (error.message === 'REVISION_CONFLICT') return apiError(409, 'REVISION_CONFLICT');
        if (error.message === 'SERVICE_UNAVAILABLE') return apiError(503, 'SERVICE_UNAVAILABLE');
        if (error.message === 'INVALID_RECOVERY_GATE') return apiError(503, 'SERVICE_UNAVAILABLE');
      }
      return apiError(400, 'INVALID_REQUEST');
    }
  }

  async alarm(): Promise<void> {
    const deploymentId = await this.ctx.storage.get<string>('deploymentId');
    if (deploymentId === undefined) throw new Error('UNKNOWN_DEPLOYMENT');
    const gate = resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId);
    const context = makeServiceContext(this.ctx.storage, gate);
    context.ensureWritable();
    for (const extension of getServiceExtensions()) await extension.alarm?.(context);
  }
}
