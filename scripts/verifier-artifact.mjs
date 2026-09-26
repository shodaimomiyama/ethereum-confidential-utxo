import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, keccak256 } from 'viem';

export const artifactPath = 'contracts/out/RangeBalanceVerifier.sol/RangeBalanceVerifier.json';
export const outputPath = 'packages/ethereum/generated/verifier-v3.json';
export const parameterPath = 'experiments/design/crypto-profile-v3/exp08/parameters.json';
export const provenancePath = 'contracts/src/verifier/provenance.json';
export const sourcePaths = [
  'contracts/src/verifier/Bn254.sol',
  'contracts/src/verifier/RangeTranscriptV3.sol',
  'contracts/src/verifier/RangeProofV3.sol',
  'contracts/src/verifier/BalanceProofV3.sol',
  'contracts/src/verifier/RangeBalanceVerifier.sol',
  'contracts/src/verifier/UPSTREAM-LICENSE.txt',
  provenancePath,
  'contracts/foundry.toml',
];
export const constructorTypes = [
  { type: 'uint256[4]' }, { type: 'uint256[128]' }, { type: 'uint256[128]' },
];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashJson = value => sha256(Buffer.from(JSON.stringify(value)));
export const hexBytes = (value, label) => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error(`${label} missing`);
  return Buffer.from(value.slice(2), 'hex');
};
export const parameters = () => {
  const source = JSON.parse(readFileSync(parameterPath, 'utf8'));
  if (source.base?.length !== 4 || source.gs?.length !== 128 || source.hs?.length !== 128) {
    throw new Error('constructor parameter shape mismatch');
  }
  return [source.base, source.gs, source.hs].map(values => values.map(BigInt));
};
export const constructorArgs = () => encodeAbiParameters(constructorTypes, parameters());

export function createVerifierRecord(artifact) {
  if (!Array.isArray(artifact.abi) || !artifact.abi.length) throw new Error('ABI missing');
  const creation = hexBytes(artifact.bytecode?.object, 'creation bytecode');
  const runtime = hexBytes(artifact.deployedBytecode?.object, 'runtime bytecode');
  if (!artifact.ast || !artifact.storageLayout || !artifact.metadata) throw new Error('compiler data missing');
  const metadata = artifact.metadata;
  if (!metadata.compiler?.version?.startsWith('0.8.37+')) throw new Error('compiler version mismatch');
  if (metadata.settings?.optimizer?.enabled !== true || metadata.settings.optimizer.runs !== 200 ||
      metadata.settings.evmVersion !== 'cancun' || metadata.settings.viaIR === true ||
      metadata.settings.compilationTarget?.['src/verifier/RangeBalanceVerifier.sol'] !== 'RangeBalanceVerifier') {
    throw new Error('compiler settings mismatch');
  }
  const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(path))]));
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const args = constructorArgs();
  const selectors = Object.fromEntries(Object.entries(artifact.methodIdentifiers ?? {})
    .filter(([name]) => name.startsWith('verify(') || name.startsWith('verifyBalance(')));
  if (selectors['verify(bytes32,uint256,uint256[10],uint256[5],uint256[],uint256[])'] !== '1e354db5' ||
      selectors['verifyBalance(bytes32,uint256,uint256,uint256,uint256,uint256)'] !== '6dc0ced9') {
    throw new Error('public selectors mismatch');
  }
  return {
    abi: artifact.abi,
    creationBytecode: artifact.bytecode.object,
    runtimeBytecode: artifact.deployedBytecode.object,
    metadata, ast: artifact.ast, storageLayout: artifact.storageLayout,
    sourceSha256,
    parametersHash: provenance.profile.parametersHash,
    constructorInputSha256: sha256(hexBytes(args, 'constructor arguments')),
    manifest: {
      compiler: metadata.compiler.version,
      abiSha256: hashJson(artifact.abi),
      creationSha256: sha256(creation), runtimeSha256: sha256(runtime),
      metadataSha256: hashJson(metadata), astSha256: hashJson(artifact.ast),
      storageLayoutSha256: hashJson(artifact.storageLayout),
      sourceMapSha256: hashJson(sourceSha256),
      constructorInputSha256: sha256(hexBytes(args, 'constructor arguments')),
    },
  };
}

export function verifyVerifierRecord(record, artifact, { requireMeasurements = true } = {}) {
  const expected = createVerifierRecord(artifact);
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(record?.[key]) !== JSON.stringify(expected[key])) throw new Error(`${key} mismatch`);
  }
  if (record.deployment) {
    if (record.deployment.runtimeSha256 !== expected.manifest.runtimeSha256 ||
        record.deployment.constructorInputSha256 !== expected.constructorInputSha256) {
      throw new Error('deployment binding mismatch');
    }
  }
  if (requireMeasurements) {
    if (!record.measurements) throw new Error('measurements missing');
    if (!record.measurementEnvironment) throw new Error('measurement environment missing');
    validateMeasurements(record.measurements, expected.manifest.runtimeSha256);
    const environment = record.measurementEnvironment;
    if (environment.chainId !== 31337 || environment.hardfork !== 'cancun' ||
        typeof environment.node !== 'string' || typeof environment.forge !== 'string' ||
        typeof environment.anvil !== 'string' || !/^[0-9]+$/.test(environment.blockGasLimit) ||
        !Array.isArray(environment.commands) || environment.commands.length === 0 ||
        typeof environment.interpretation !== 'string' ||
        !environment.interpretation.includes('no Pool operation')) {
      throw new Error('measurement environment invalid');
    }
  }
  return expected;
}

export function validateMeasurements(measurements, runtimeSha256) {
  if (!Array.isArray(measurements) || measurements.length !== 3) throw new Error('measurement count mismatch');
  const types = ['deployment', 'range', 'balance'];
  for (let i = 0; i < types.length; ++i) {
    const row = measurements[i];
    if (row?.type !== types[i] || typeof row.inputId !== 'string' || !row.inputId ||
        row.chainId !== 31337 || row.hardfork !== 'cancun' || row.runtimeSha256 !== runtimeSha256 ||
        typeof row.compiler !== 'string' || typeof row.caller !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(row.caller) || !Number.isSafeInteger(row.gasUsed) || row.gasUsed <= 0) {
      throw new Error(`invalid ${types[i]} measurement`);
    }
    if (row.type !== 'deployment' && (!Number.isSafeInteger(row.estimateGas) || row.estimateGas <= 0)) {
      throw new Error(`missing ${types[i]} estimate`);
    }
  }
  if (measurements.some(row => row.type === 'pool-operation')) throw new Error('Pool total gas is not measured');
}
