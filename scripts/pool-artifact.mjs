import { readFileSync } from 'node:fs';
import { sha256, hashJson, hexBytes } from './verifier-artifact.mjs';

export const artifactPath = 'contracts/out/Pool.sol/Pool.json';
export const outputPath = 'packages/ethereum/generated/pool-v1.json';
export const sourcePaths = [
  'contracts/src/Pool.sol', 'contracts/src/IPool.sol', 'contracts/src/PoolTypes.sol',
  'contracts/src/PoolBinding.sol', 'contracts/src/verifier/Bn254.sol', 'contracts/foundry.toml',
];

export function createPoolRecord(artifact) {
  if (!Array.isArray(artifact.abi) || !artifact.ast || !artifact.storageLayout || !artifact.metadata) {
    throw new Error('Pool compiler artifact incomplete');
  }
  const settings = artifact.metadata.settings;
  if (!artifact.metadata.compiler.version.startsWith('0.8.37+') || !settings.optimizer.enabled ||
      settings.optimizer.runs !== 200 || settings.evmVersion !== 'cancun' || settings.viaIR === true ||
      settings.compilationTarget?.['src/Pool.sol'] !== 'Pool') throw new Error('Pool compiler settings mismatch');
  const methodIdentifiers = artifact.methodIdentifiers;
  for (const name of ['deposit(', 'transfer(', 'withdraw(', 'getUtxo(', 'isOperationExecuted(', 'getAccounting(']) {
    if (!Object.keys(methodIdentifiers).some(key => key.startsWith(name))) throw new Error(`Pool method ${name} missing`);
  }
  if (Object.keys(methodIdentifiers).length !== 7 || !methodIdentifiers['verifier()']) {
    throw new Error('Pool public function set mismatch');
  }
  if (artifact.abi.filter(item => item.type === 'error').length !== 15 ||
      artifact.abi.filter(item => item.type === 'event').length !== 3) throw new Error('Pool error/event ABI mismatch');
  const creation = hexBytes(artifact.bytecode.object, 'Pool creation bytecode');
  const runtime = hexBytes(artifact.deployedBytecode.object, 'Pool runtime bytecode');
  const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(path))]));
  const record = {
    schemaVersion: 1, abi: artifact.abi, methodIdentifiers,
    creationBytecode: artifact.bytecode.object, runtimeBytecode: artifact.deployedBytecode.object,
    immutableReferences: artifact.deployedBytecode.immutableReferences,
    metadata: artifact.metadata, ast: artifact.ast, storageLayout: artifact.storageLayout,
    sourceSha256,
    manifest: {
      compiler: artifact.metadata.compiler.version, abiSha256: hashJson(artifact.abi),
      creationSha256: sha256(creation), runtimeSha256: sha256(runtime),
      metadataSha256: hashJson(artifact.metadata), astSha256: hashJson(artifact.ast),
      storageLayoutSha256: hashJson(artifact.storageLayout), sourceMapSha256: hashJson(sourceSha256),
    },
  };
  return record;
}

export function verifyPoolRecord(record, artifact) {
  const expected = createPoolRecord(artifact);
  if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error('Pool record differs from current compiler artifact or sources');
  return expected;
}
