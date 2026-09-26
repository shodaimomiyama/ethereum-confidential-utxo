import { describe, expect, it } from 'vitest';
import { createEnvironmentManifest, verifyEnvironmentArtifact } from '../../scripts/environment-artifact.mjs';

const artifact = {
  abi: [{ type: 'function', name: 'answer', stateMutability: 'pure', inputs: [], outputs: [{ type: 'uint256' }] }],
  bytecode: { object: '0x60016000' },
  deployedBytecode: { object: '0x60016000' },
  ast: { nodeType: 'SourceUnit' },
  storageLayout: { storage: [], types: {} },
  metadata: { compiler: { version: '0.8.37+commit.f401782d' }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' } },
};
const source = 'contract EnvironmentSmoke {}';
const config = 'solc_version = "0.8.37"';

describe('official artifact guard', () => {
  it('accepts the exact source, settings and runtime recorded in the manifest', () => {
    const manifest = createEnvironmentManifest(artifact, source, config);
    expect(() => verifyEnvironmentArtifact(artifact, manifest, source, config)).not.toThrow();
  });

  it('rejects a changed runtime before it reaches deployment or proof', () => {
    const manifest = createEnvironmentManifest(artifact, source, config);
    const changed = structuredClone(artifact);
    changed.deployedBytecode.object = '0x60026000';
    expect(() => verifyEnvironmentArtifact(changed, manifest, source, config)).toThrow(/runtime/i);
  });

  it('rejects missing AST and storage layout', () => {
    const manifest = createEnvironmentManifest(artifact, source, config);
    for (const field of ['ast', 'storageLayout']) {
      const changed = structuredClone(artifact);
      delete changed[field];
      expect(() => verifyEnvironmentArtifact(changed, manifest, source, config)).toThrow(field);
    }
  });

  it('rejects a different source or compiler settings', () => {
    const manifest = createEnvironmentManifest(artifact, source, config);
    expect(() => verifyEnvironmentArtifact(artifact, manifest, `${source} changed`, config)).toThrow(/source/i);
    expect(() => verifyEnvironmentArtifact(artifact, manifest, source, `${config} changed`)).toThrow(/config/i);
  });
});
