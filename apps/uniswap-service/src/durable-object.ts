import { DurableObject } from 'cloudflare:workers';
import { applyMigrations } from './schema.js';
import type { ServiceEnv } from './index.js';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { createChallenge, readSessionIdentity, verifyChallenge } from './auth.js';
import { parseDeploymentCatalog, resolveDeployment } from './config.js';
import { apiError, apiSuccess, BodyTooLarge, readLimitedJson } from './http.js';

export class UniswapServiceObject extends DurableObject<ServiceEnv> {
  constructor(ctx: DurableObjectState, env: ServiceEnv) {
    super(ctx, env);
    applyMigrations(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await readLimitedJson(request);
      const parsed = parseApiRequest(request.method, url.pathname + url.search, body);
      const config = resolveDeployment(parsed.scope.deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
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
        return apiSuccess({ availability: 'healthy', records: [] });
      }
      return apiError(503, 'SERVICE_UNAVAILABLE');
    } catch (error) {
      if (error instanceof BodyTooLarge) return apiError(413, 'PAYLOAD_TOO_LARGE');
      if (error instanceof Error) {
        if (error.message === 'UNKNOWN_DEPLOYMENT') return apiError(503, 'SERVICE_UNAVAILABLE');
        if (error.message === 'CHALLENGE_USED') return apiError(401, 'CHALLENGE_USED');
        if (error.message === 'CHALLENGE_EXPIRED') return apiError(401, 'CHALLENGE_EXPIRED');
        if (error.message === 'UNAUTHENTICATED') return apiError(401, 'UNAUTHENTICATED');
      }
      return apiError(400, 'INVALID_REQUEST');
    }
  }
}
