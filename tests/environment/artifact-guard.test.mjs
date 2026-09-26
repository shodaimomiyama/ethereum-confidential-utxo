import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { createEnvironmentManifest, verifyEnvironmentArtifact, verifyGeneratedEnvironmentFixture } from '../../scripts/environment-artifact.mjs';

const source = 'contract EnvironmentSmoke {}';
const config = readFileSync('contracts/foundry.toml', 'utf8');

const artifact = {
  abi: [{ type: 'function', name: 'answer', stateMutability: 'pure', inputs: [], outputs: [{ type: 'uint256' }] }],
  bytecode: { object: '0x60016000' },
  deployedBytecode: { object: '0x60016000' },
  ast: { nodeType: 'SourceUnit' },
  storageLayout: { storage: [], types: {} },
  metadata: {
    compiler: { version: '0.8.37+commit.f401782d' },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', compilationTarget: { 'test/EnvironmentSmoke.t.sol': 'EnvironmentSmoke' } },
    sources: { 'test/EnvironmentSmoke.t.sol': { keccak256: keccak256(toHex(source)) } },
  },
};

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
    expect(() => createEnvironmentManifest(artifact, `${source} changed`, config)).toThrow(/source/i);
    expect(() => createEnvironmentManifest(artifact, source, 'optimizer_runs = 999')).toThrow(/config/i);
  });

  it('rejects viaIR enabled by an external Foundry override', () => {
    const changed = structuredClone(artifact);
    changed.metadata.settings.viaIR = true;
    expect(() => createEnvironmentManifest(changed, source, config)).toThrow(/viaIR/i);
  });

  it('rejects generated ABI and creation bytecode changed after export', () => {
    const manifest = createEnvironmentManifest(artifact, source, config);
    const generated = {
      abi: artifact.abi,
      creationBytecode: artifact.bytecode.object,
      runtimeBytecode: artifact.deployedBytecode.object,
      manifest,
    };
    expect(() => verifyGeneratedEnvironmentFixture(artifact, generated, source, config)).not.toThrow();
    expect(() => verifyGeneratedEnvironmentFixture(artifact, { ...generated, abi: [] }, source, config)).toThrow(/ABI/i);
    expect(() => verifyGeneratedEnvironmentFixture(artifact, { ...generated, creationBytecode: '0x60006000' }, source, config)).toThrow(/creation/i);
  });
});
