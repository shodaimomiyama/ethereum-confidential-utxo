export interface SiteConfig {
  readonly mode: 'mock' | 'live';
  readonly codeUrl?: string;
  readonly evidenceUrl?: string;
  readonly faucetUrl?: string;
  readonly deploymentId: string;
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
  return {
    mode,
    codeUrl: optionalUrl(env.VITE_DIM_CODE_URL, 'VITE_DIM_CODE_URL'),
    evidenceUrl: optionalUrl(env.VITE_DIM_EVIDENCE_URL, 'VITE_DIM_EVIDENCE_URL'),
    faucetUrl: optionalUrl(env.VITE_DIM_FAUCET_URL, 'VITE_DIM_FAUCET_URL'),
    deploymentId: env.VITE_DIM_DEPLOYMENT_ID?.trim() || 'local-v1',
  };
}
