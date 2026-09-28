import type { DeploymentId } from '@confidential-utxo/uniswap';

export interface VerifiedConnectionEvidence {
  readonly deploymentId: string;
  readonly generation: string;
  readonly chainId: number;
  readonly pool: string;
  readonly adapter: string;
}

export interface ServiceDeploymentConfig {
  readonly origin: string;
  readonly siweUri: string;
  readonly chainId: number;
  readonly pool: string;
  readonly finalityMode: 'finalized' | 'local-simulated';
}

export interface BrowserDeployment {
  readonly deploymentId: DeploymentId;
  readonly chainId: bigint;
  readonly pool: `0x${string}`;
  readonly adapter: `0x${string}`;
  readonly origin: string;
  readonly siweUri: string;
}

type ObjectValue = Record<string, unknown>;
const address = /^0x[0-9a-fA-F]{40}$/;
const id = /^[\x21-\x7e]+$/;

function invalid(): never { throw new Error('INVALID_DEPLOYMENT'); }
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as ObjectValue;
}
function validAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && address.test(value) && !/^0x0{40}$/i.test(value);
}
function sameAddress(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function chainId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string') invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value
    || url.pathname !== '/' || url.search || url.hash) invalid();
  return value;
}

function parseSiweUri(value: unknown, origin: string): string {
  if (typeof value !== 'string') invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== origin
    || url.hash || url.search || url.href !== value) invalid();
  return value;
}

function snapshot(value: unknown): string {
  try {
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol'
        || (typeof item === 'number' && !Number.isFinite(item))) invalid();
      return item;
    });
    if (encoded === undefined) invalid();
    return encoded;
  } catch { return invalid(); }
}

/**
 * The caller must supply evidence from an independent deployment verification step.
 * This browser parser only checks that pinned evidence, manifest, and service
 * configuration agree; it does not verify on-chain code or authenticate a manifest.
 */
export function createDeploymentResolver(input: {
  readonly readManifest: () => unknown;
  readonly verified: VerifiedConnectionEvidence;
  readonly catalogue: Readonly<Record<string, ServiceDeploymentConfig>>;
}): (deploymentId: DeploymentId) => BrowserDeployment | undefined {
  const rawManifest = input.readManifest();
  const manifestSnapshot = snapshot(rawManifest);
  const manifest = object(rawManifest);
  const verified = object(input.verified) as unknown as VerifiedConnectionEvidence;
  object(input.catalogue);
  if (manifest.schemaVersion !== 1 || !chainId(manifest.chainId)
    || typeof manifest.generation !== 'string' || !id.test(manifest.generation)
    || typeof verified.deploymentId !== 'string' || !id.test(verified.deploymentId)
    || verified.generation !== manifest.generation || verified.chainId !== manifest.chainId) invalid();
  const contracts = object(manifest.contracts);
  const poolRecord = object(contracts.pool);
  const adapterRecord = object(contracts.adapter);
  const references = object(manifest.references);
  const site = object(manifest.site);
  if (!validAddress(poolRecord.address) || !validAddress(adapterRecord.address)
    || !validAddress(adapterRecord.pool) || !validAddress(references.corePoolAddress)
    || !validAddress(verified.pool) || !validAddress(verified.adapter)
    || !sameAddress(poolRecord.address, adapterRecord.pool)
    || sameAddress(poolRecord.address, references.corePoolAddress)
    || !sameAddress(poolRecord.address, verified.pool)
    || !sameAddress(adapterRecord.address, verified.adapter)
    || site.deploymentId !== verified.deploymentId) invalid();
  const origin = parseOrigin(site.origin);
  const siweUri = parseSiweUri(site.siweUri, origin);
  if (!Object.hasOwn(input.catalogue, verified.deploymentId)) invalid();
  const service = input.catalogue[verified.deploymentId];
  if (!service || service.chainId !== manifest.chainId || !validAddress(service.pool)
    || !sameAddress(service.pool, verified.pool) || service.origin !== origin
    || service.siweUri !== siweUri || parseOrigin(service.origin) !== origin
    || parseSiweUri(service.siweUri, origin) !== siweUri
    || !['finalized', 'local-simulated'].includes(service.finalityMode)
    || (service.finalityMode === 'local-simulated' && service.chainId !== 31337)) invalid();
  const catalogueSnapshot = snapshot(input.catalogue);
  const evidenceSnapshot = snapshot(verified);
  const resolved: BrowserDeployment = Object.freeze({
    deploymentId: verified.deploymentId as DeploymentId,
    chainId: BigInt(manifest.chainId), pool: poolRecord.address,
    adapter: adapterRecord.address, origin, siweUri,
  });
  return requested => {
    if (snapshot(input.readManifest()) !== manifestSnapshot
      || snapshot(input.catalogue) !== catalogueSnapshot
      || snapshot(input.verified) !== evidenceSnapshot) throw new Error('DEPLOYMENT_CHANGED');
    return requested === resolved.deploymentId ? resolved : undefined;
  };
}
