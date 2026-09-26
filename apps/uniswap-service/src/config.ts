export interface DeploymentConfig {
  readonly origin: string;
  readonly siweUri: string;
  readonly chainId: number;
  readonly pool: string;
}

export type DeploymentCatalog = Readonly<Record<string, DeploymentConfig>>;

export function resolveDeployment(deploymentId: string, catalog: DeploymentCatalog): DeploymentConfig {
  if (!Object.hasOwn(catalog, deploymentId)) throw new Error('UNKNOWN_DEPLOYMENT');
  const config = catalog[deploymentId];
  if (config === undefined || !Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new Error('INVALID_DEPLOYMENT_CONFIG');
  }
  const origin = new URL(config.origin);
  const siweUri = new URL(config.siweUri);
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || siweUri.origin !== origin.origin
    || !/^0x[0-9a-fA-F]{40}$/.test(config.pool)) {
    throw new Error('INVALID_DEPLOYMENT_CONFIG');
  }
  return config;
}

export function parseDeploymentCatalog(source: string): DeploymentCatalog {
  const raw: unknown = JSON.parse(source);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_DEPLOYMENT_CONFIG');
  return raw as DeploymentCatalog;
}
