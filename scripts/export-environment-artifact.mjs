import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createEnvironmentManifest } from './environment-artifact.mjs';

const artifactPath = resolve('contracts/out/EnvironmentSmoke.t.sol/EnvironmentSmoke.json');
const sourcePath = resolve('contracts/test/EnvironmentSmoke.t.sol');
const configPath = resolve('contracts/foundry.toml');
const outputPath = resolve('packages/ethereum/generated/environment-smoke.json');

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const source = readFileSync(sourcePath, 'utf8');
const config = readFileSync(configPath, 'utf8');
const manifest = createEnvironmentManifest(artifact, source, config);
const generated = {
  abi: artifact.abi,
  creationBytecode: artifact.bytecode.object,
  runtimeBytecode: artifact.deployedBytecode.object,
  manifest,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
console.log(`Environment artifact: ${manifest.artifactSha256}`);
console.log(`Runtime: ${manifest.runtimeSha256}`);
