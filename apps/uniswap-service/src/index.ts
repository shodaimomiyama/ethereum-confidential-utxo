import { parseDeploymentCatalog, resolveDeployment } from './config.js';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { UniswapServiceObject } from './durable-object.js';
import { apiError, assertBundleSize, BodyTooLarge, readLimitedJson } from './http.js';

export interface ServiceEnv {
  readonly UNISWAP_STATE: DurableObjectNamespace<UniswapServiceObject>;
  readonly DEPLOYMENTS_JSON: string;
}

export { UniswapServiceObject };

export default {
  async fetch(request: Request, env: ServiceEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await readLimitedJson(request);
      assertBundleSize(body);
      const parsed = parseApiRequest(request.method, url.pathname + url.search, body);
      const deployment = resolveDeployment(parsed.scope.deploymentId, parseDeploymentCatalog(env.DEPLOYMENTS_JSON));
      if (url.origin !== deployment.origin) return apiError(403, 'SCOPE_MISMATCH');
      if (request.method !== 'GET' && request.headers.get('origin') !== deployment.origin) {
        return apiError(403, 'SCOPE_MISMATCH');
      }
      const id = env.UNISWAP_STATE.idFromName(parsed.scope.deploymentId);
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const forwarded = new Request(request.url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      try {
        return await env.UNISWAP_STATE.get(id).fetch(forwarded);
      } catch {
        return apiError(503, 'SERVICE_UNAVAILABLE');
      }
    } catch (error) {
      if (error instanceof BodyTooLarge) return apiError(413, 'PAYLOAD_TOO_LARGE');
      if (error instanceof Error && error.message === 'UNKNOWN_DEPLOYMENT') return apiError(503, 'SERVICE_UNAVAILABLE');
      return apiError(400, 'INVALID_REQUEST');
    }
  },
};
