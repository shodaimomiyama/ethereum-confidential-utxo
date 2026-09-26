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

export function verifyVerifierRecord(record, artifact) {
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
  return expected;
}
