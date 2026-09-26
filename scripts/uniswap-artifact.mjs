import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import { verifyUniswapSources } from './uniswap-source.mjs';

const root = 'vendor/uniswap-v2';
const outputPath = 'packages/ethereum/generated/uniswap-v2.json';
const artifactPaths = {
  factory: `${root}/out/UniswapV2Factory.sol/UniswapV2Factory.json`,
  pair: `${root}/out/UniswapV2Pair.sol/UniswapV2Pair.json`,
  router02: `${root}/out/UniswapV2Router02.sol/UniswapV2Router02.json`,
  weth9: `${root}/out/WETH9.sol/WETH9.json`,
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function loadUniswapArtifacts() {
  const lock = JSON.parse(readFileSync(`${root}/source-lock.json`, 'utf8'));
  verifyUniswapSources(root, lock);
  const artifacts = Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) =>
    [name, JSON.parse(readFileSync(path, 'utf8'))]));
  const library = readFileSync(`${root}/periphery/contracts/libraries/UniswapV2Library.sol`, 'utf8');
  const match = library.match(/hex'([0-9a-f]{64})'\s*\/\/ init code hash/i);
  if (!match) throw new Error('Router Pair init code hash missing');
  artifacts.factory.pairInitCodeHash = keccak256(artifacts.pair.bytecode.object);
  artifacts.router02.pairInitCodeHash = `0x${match[1]}`;
  assertPairAddressConsistency(artifacts.factory, artifacts.pair, artifacts.router02);
  const provenance = {
    commits: Object.fromEntries(Object.entries(lock.upstream).map(([name, source]) => [name, source.commit])),
    compilers: lock.compilers,
    localPatch: lock.localPatch,
    sourceLockSha256: sha256(readFileSync(`${root}/source-lock.json`)),
  };
  validateUniswapProvenance(provenance);
  if (!artifacts.factory.metadata.compiler.version.startsWith('0.5.16+') ||
      !artifacts.pair.metadata.compiler.version.startsWith('0.5.16+') ||
      !artifacts.router02.metadata.compiler.version.startsWith('0.6.6+') ||
      !artifacts.weth9.metadata.compiler.version.startsWith('0.6.6+')) {
    throw new Error('Uniswap compiler version mismatch');
  }
  return { ...artifacts, provenance };
}

export function createUniswapArtifactBundle() {
  const { provenance, ...artifacts } = loadUniswapArtifacts();
  const compact = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => {
    const creation = value.bytecode.object;
    const runtime = value.deployedBytecode.object;
    return [name, {
      abi: value.abi,
      creationBytecode: creation,
      runtimeBytecode: runtime,
      creationKeccak256: keccak256(creation),
      runtimeSha256: sha256(Buffer.from(runtime.slice(2), 'hex')),
      compiler: value.metadata.compiler.version,
      settings: value.metadata.settings,
    }];
  }));
  return { schemaVersion: 1, provenance, pairInitCodeHash: compact.pair.creationKeccak256, artifacts: compact };
}

export function assertPairAddressConsistency(factoryArtifact, pairArtifact, routerArtifact) {
  const creation = typeof pairArtifact?.bytecode === 'string' ? pairArtifact.bytecode : pairArtifact?.bytecode?.object;
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(creation ?? '')) {
    throw new Error('Pair creation bytecode missing');
  }
  const expected = keccak256(creation).toLowerCase();
  if (factoryArtifact?.pairInitCodeHash?.toLowerCase() !== expected ||
      routerArtifact?.pairInitCodeHash?.toLowerCase() !== expected) {
    throw new Error('Pair init code hash mismatch');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'build') {
    execFileSync('forge', ['build', 'core/contracts/UniswapV2Factory.sol', '--root', root, '--use', '0.5.16'], { stdio: 'inherit' });
    execFileSync('forge', ['build', 'periphery/contracts/UniswapV2Router02.sol',
      'periphery/contracts/test/WETH9.sol', '--root', root, '--use', '0.6.6'], { stdio: 'inherit' });
  } else if (action !== 'verify') {
    throw new Error('usage: node scripts/uniswap-artifact.mjs build|verify');
  }
  const bundle = createUniswapArtifactBundle();
  if (action === 'build') {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  } else {
    const published = JSON.parse(readFileSync(outputPath, 'utf8'));
    if (JSON.stringify(published) !== JSON.stringify(bundle)) throw new Error('published Uniswap artifact mismatch');
  }
  console.log(`Uniswap artifact ${action}: ${outputPath}`);
}

export function validateUniswapProvenance(record) {
  if (!record?.commits || !record?.compilers || !record?.localPatch ||
      !['core', 'periphery', 'lib'].every(name => /^[0-9a-f]{40}$/i.test(record.commits[name] ?? '')) ||
      record.compilers.core !== '0.5.16' || record.compilers.periphery !== '0.6.6' ||
      !record.localPatch.file || !record.localPatch.before || !record.localPatch.after) {
    throw new Error('Uniswap provenance incomplete');
  }
}
