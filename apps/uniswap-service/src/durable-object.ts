import { DurableObject } from 'cloudflare:workers';
import { applyMigrations } from './schema.js';
import type { ServiceEnv } from './index.js';

export class UniswapServiceObject extends DurableObject<ServiceEnv> {
  constructor(ctx: DurableObjectState, env: ServiceEnv) {
    super(ctx, env);
    applyMigrations(ctx.storage);
  }

  async fetch(_request: Request): Promise<Response> {
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE', allowedActions: [] } }, { status: 503 });
  }
}
