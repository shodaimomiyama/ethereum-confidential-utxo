import { describe, expect, it } from 'vitest';
import type { DeploymentId } from '@confidential-utxo/uniswap';
import { createDeploymentResolver } from '../../src/live/deployment.js';

const pool = `0x${'11'.repeat(20)}`;
const adapter = `0x${'22'.repeat(20)}`;
const origin = 'https://wallet.example.test';
const siweUri = `${origin}/login`;
const deploymentId = 'sepolia-1' as DeploymentId;

function fixture() {
  let manifest: unknown = {
    schemaVersion: 1, chainId: 11155111, generation: 'sepolia-1',
    contracts: { pool: { address: pool }, adapter: { address: adapter, pool } },
    references: { corePoolAddress: `0x${'33'.repeat(20)}` },
    site: { deploymentId: 'sepolia-1', origin, siweUri },
  };
  const catalogue = { 'sepolia-1': { origin, siweUri, chainId: 11155111, pool, finalityMode: 'finalized' as const } };
  const verified = { deploymentId: 'sepolia-1', generation: 'sepolia-1', chainId: 11155111, pool, adapter };
  return { readManifest: () => manifest, setManifest: (value: unknown) => { manifest = value; }, catalogue, verified };
}

describe('browser deployment resolver', () => {
  it('exposes a pinned connection for the matching deployment only', () => {
    const resolver = createDeploymentResolver(fixture());
    expect(resolver(deploymentId)).toEqual({ deploymentId, chainId: 11155111n,
      pool, adapter, origin, siweUri });
    expect(resolver('other' as DeploymentId)).toBeUndefined();
  });

  it('checks connection fields without treating browser parsing as on-chain verification', () => {
    const input = fixture();
    const manifest = input.readManifest() as { contracts: { pool: object } };
    input.setManifest({ ...manifest, contracts: {
      ...manifest.contracts, pool: { ...manifest.contracts.pool, runtimeSha256: 'unverified-runtime' },
    } });
    expect(createDeploymentResolver(input)(deploymentId)?.pool).toBe(pool);
  });

  it('refuses asset-only and incomplete manifests', () => {
    for (const change of [
      { site: null }, { contracts: { pool: { address: pool } } },
      { contracts: { pool: { address: pool }, adapter: { address: adapter } } },
    ]) {
      const input = fixture();
      input.setManifest({ ...(input.readManifest() as object), ...change });
      expect(() => createDeploymentResolver(input)).toThrow('INVALID_DEPLOYMENT');
    }
  });

  it('requires independently supplied verification evidence and a service catalogue', () => {
    const input = fixture();
    expect(() => createDeploymentResolver({ ...input, verified: undefined as never }))
      .toThrow('INVALID_DEPLOYMENT');
    expect(() => createDeploymentResolver({ ...input, catalogue: null as never }))
      .toThrow('INVALID_DEPLOYMENT');
  });

  it('rejects untrusted URL forms and cross-origin SIWE URIs', () => {
    for (const [badOrigin, badSiwe] of [
      ['http://wallet.example.test', 'http://wallet.example.test/login'],
      ['https://user@wallet.example.test', siweUri],
      ['https://wallet.example.test/path', siweUri],
      ['https://wallet.example.test?token=x', siweUri],
      [origin, 'https://elsewhere.test/login'],
      [origin, 'https://wallet.example.test/login#fragment'],
      [origin, 'https://wallet.example.test/login?token=secret'],
    ]) {
      const input = fixture();
      input.setManifest({ ...(input.readManifest() as object), site: {
        deploymentId: 'sepolia-1', origin: badOrigin, siweUri: badSiwe,
      } });
      expect(() => createDeploymentResolver(input)).toThrow('INVALID_DEPLOYMENT');
    }
  });

  it('requires manifest, verified evidence, and service catalogue to agree', () => {
    const changes = [
      (input: ReturnType<typeof fixture>) => { input.verified.chainId = 1; },
      (input: ReturnType<typeof fixture>) => { input.verified.adapter = pool; },
      (input: ReturnType<typeof fixture>) => { input.catalogue['sepolia-1'].pool = adapter; },
      (input: ReturnType<typeof fixture>) => { input.catalogue['sepolia-1'].siweUri = `${origin}/other`; },
      (input: ReturnType<typeof fixture>) => { input.setManifest({ ...(input.readManifest() as object), generation: 'other' }); },
    ];
    for (const change of changes) {
      const input = fixture(); change(input);
      expect(() => createDeploymentResolver(input)).toThrow('INVALID_DEPLOYMENT');
    }
  });

  it('fails closed when the manifest or catalogue changes after creation', () => {
    const input = fixture();
    const resolver = createDeploymentResolver(input);
    input.setManifest({ ...(input.readManifest() as object), provenance: { sourceCommit: 'different' } });
    expect(() => resolver(deploymentId)).toThrow('DEPLOYMENT_CHANGED');
    const other = fixture();
    const otherResolver = createDeploymentResolver(other);
    other.catalogue['sepolia-1'].pool = adapter;
    expect(() => otherResolver(deploymentId)).toThrow('DEPLOYMENT_CHANGED');
  });
});
