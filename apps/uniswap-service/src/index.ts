import { parseDeploymentCatalog, resolveDeployment } from './config.js';
import { UniswapServiceObject } from './durable-object.js';

export interface ServiceEnv {
  readonly UNISWAP_STATE: DurableObjectNamespace<UniswapServiceObject>;
  readonly DEPLOYMENTS_JSON: string;
}

export { UniswapServiceObject };

export default {
  async fetch(request: Request, env: ServiceEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const deploymentId = url.searchParams.get('deploymentId');
      if (deploymentId === null) throw new Error('UNKNOWN_DEPLOYMENT');
      const deployment = resolveDeployment(deploymentId, parseDeploymentCatalog(env.DEPLOYMENTS_JSON));
      if (url.origin !== deployment.origin) throw new Error('WRONG_ORIGIN');
      const id = env.UNISWAP_STATE.idFromName(deploymentId);
      return env.UNISWAP_STATE.get(id).fetch(request);
    } catch {
      return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE', allowedActions: [] } }, { status: 503 });
    }
  },
};
