import { createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashText = (value) => hash(Buffer.from(value, 'utf8'));
const hashJson = (value) => hashText(JSON.stringify(value));
const expectedConfigSha256 = '698fc9506ad1fa0041b2c5a0f8e41933f72db6afad0966ed5fb704bd68bd23ee';

function bytecode(value, name) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${name} must be nonempty 0x-prefixed bytes`);
  }
  return Buffer.from(value.slice(2), 'hex');
}

function validateArtifact(artifact, source) {
  if (!Array.isArray(artifact?.abi) || artifact.abi.length === 0) throw new Error('ABI missing');
  bytecode(artifact.bytecode?.object, 'creation bytecode');
  bytecode(artifact.deployedBytecode?.object, 'runtime bytecode');
  if (!artifact.ast || typeof artifact.ast !== 'object') throw new Error('ast missing');
  if (!artifact.storageLayout || typeof artifact.storageLayout !== 'object') throw new Error('storageLayout missing');
  if (!artifact.metadata?.compiler?.version?.startsWith('0.8.37+')) throw new Error('compiler version mismatch');
  const settings = artifact.metadata.settings;
  if (settings?.optimizer?.enabled !== true || settings.optimizer.runs !== 200 || settings.evmVersion !== 'cancun') {
    throw new Error('compiler settings mismatch');
  }
  if (settings.viaIR !== undefined && settings.viaIR !== false) throw new Error('viaIR must be false');
  if (settings.compilationTarget?.['test/EnvironmentSmoke.t.sol'] !== 'EnvironmentSmoke') {
    throw new Error('compiler target mismatch');
  }
  if (artifact.metadata.sources?.['test/EnvironmentSmoke.t.sol']?.keccak256 !== keccak256(toHex(source))) {
    throw new Error('artifact source hash mismatch');
  }
}

export function createEnvironmentManifest(artifact, source, config) {
  if (hashText(config) !== expectedConfigSha256) throw new Error('foundry config mismatch');
  validateArtifact(artifact, source);
  return {
    compiler: artifact.metadata.compiler.version,
    artifactSha256: hashJson(artifact),
    sourceSha256: hashText(source),
    configSha256: hashText(config),
    abiSha256: hashJson(artifact.abi),
    creationSha256: hash(bytecode(artifact.bytecode.object, 'creation bytecode')),
    runtimeSha256: hash(bytecode(artifact.deployedBytecode.object, 'runtime bytecode')),
  };
}

export function verifyEnvironmentArtifact(artifact, manifest, source, config) {
  const expected = createEnvironmentManifest(artifact, source, config);
  for (const name of ['runtimeSha256', 'creationSha256', 'abiSha256', 'sourceSha256', 'configSha256', 'artifactSha256', 'compiler']) {
    if (manifest?.[name] !== expected[name]) throw new Error(`${name.replace('Sha256', '')} mismatch`);
  }
  return expected;
}

export function verifyGeneratedEnvironmentFixture(artifact, generated, source, config) {
  const manifest = verifyEnvironmentArtifact(artifact, generated?.manifest, source, config);
  if (hashJson(generated.abi) !== manifest.abiSha256) throw new Error('generated ABI mismatch');
  if (hash(bytecode(generated.creationBytecode, 'generated creation bytecode')) !== manifest.creationSha256) {
    throw new Error('generated creation bytecode mismatch');
  }
  if (hash(bytecode(generated.runtimeBytecode, 'generated runtime bytecode')) !== manifest.runtimeSha256) {
    throw new Error('generated runtime bytecode mismatch');
  }
  return manifest;
}
