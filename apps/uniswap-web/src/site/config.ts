export interface SiteConfig {
  readonly mode: 'mock' | 'live';
  readonly codeUrl?: string;
  readonly evidenceUrl?: string;
  readonly faucetUrl?: string;
  readonly deploymentId: string;
  readonly liveConfigUrl?: string;
  readonly liveConfigSha256?: string;
  readonly explorerByDeployment?: Readonly<Record<string, string>>;
}

function optionalUrl(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  return url.toString();
}

export function readSiteConfig(env: Record<string, string | undefined>): SiteConfig {
  const mode = env.VITE_DIM_MODE ?? 'mock';
  if (mode !== 'mock' && mode !== 'live') throw new Error('VITE_DIM_MODE must be mock or live');
  const deploymentId = env.VITE_DIM_DEPLOYMENT_ID?.trim() || 'local-v1';
  const explorerBase = optionalUrl(env.VITE_DIM_EXPLORER_BASE, 'VITE_DIM_EXPLORER_BASE');
  const liveConfigUrl = env.VITE_DIM_LIVE_CONFIG_URL?.trim();
  const liveConfigSha256 = env.VITE_DIM_LIVE_CONFIG_SHA256?.trim();
  if (mode === 'live' && liveConfigSha256 && !/^[0-9a-fA-F]{64}$/.test(liveConfigSha256)) {
    throw new Error('INVALID_LIVE_CONFIG_SHA256');
  }
  return {
    mode,
    codeUrl: optionalUrl(env.VITE_DIM_CODE_URL, 'VITE_DIM_CODE_URL'),
    evidenceUrl: optionalUrl(env.VITE_DIM_EVIDENCE_URL, 'VITE_DIM_EVIDENCE_URL'),
    faucetUrl: optionalUrl(env.VITE_DIM_FAUCET_URL, 'VITE_DIM_FAUCET_URL'),
    deploymentId,
    ...(mode === 'live' ? { liveConfigUrl, liveConfigSha256 } : {}),
    explorerByDeployment: explorerBase ? { [deploymentId]: explorerBase.replace(/\/$/, '') } : {},
  };
}
