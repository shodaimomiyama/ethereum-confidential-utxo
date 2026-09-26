import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createWalletClient, encodeDeployData, http } from 'viem';
import { verifyDeployment } from './pool-deployment.mjs';
import { artifactPath, outputPath, verifyUniswapPaymentRecord } from './uniswap-payment-artifact.mjs';
import { createUniswapManifest } from './uniswap-manifest.mjs';
import { verifyLocalAssets } from './uniswap-local.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const codeHash = code => sha256(Buffer.from(code.slice(2), 'hex'));
const same = (left, right) => left?.toLowerCase() === right?.toLowerCase();
const referenceNames = ['pool', 'router02', 'factory', 'weth', 'dUSD', 'pair'];

function loadAdapter() {
  return verifyUniswapPaymentRecord(JSON.parse(readFileSync(outputPath, 'utf8')),
    JSON.parse(readFileSync(artifactPath, 'utf8')));
}

function immutableIds(artifact) {
  const contract = artifact.ast.nodes.find(node =>
    node.nodeType === 'ContractDefinition' && node.name === 'UniswapPaymentAdapter');
  const declarations = contract?.nodes.filter(node => node.nodeType === 'VariableDeclaration' &&
    node.mutability === 'immutable') ?? [];
  const ids = new Map(declarations.map(node => [node.name, String(node.id)]));
  if (referenceNames.some(name => !ids.has(name)) || ids.size !== referenceNames.length) {
    throw new Error('Adapter immutable declarations mismatch');
  }
  return ids;
}

function adapterRuntimeFor(artifact, refs) {
  const ids = immutableIds(artifact);
  let code = artifact.runtimeBytecode.slice(2).toLowerCase();
  const entries = Object.entries(artifact.immutableReferences);
  if (entries.length !== referenceNames.length) throw new Error('Adapter immutable references mismatch');
  for (const name of referenceNames) {
    const locations = artifact.immutableReferences[ids.get(name)];
    if (!locations?.length || locations.some(({ start, length }) =>
      !Number.isSafeInteger(start) || length !== 32 || start * 2 + 64 > code.length)) {
      throw new Error(`Adapter ${name} immutable references invalid`);
    }
    const word = refs[name].slice(2).toLowerCase().padStart(64, '0');
    for (const { start } of locations) {
      code = `${code.slice(0, start * 2)}${word}${code.slice(start * 2 + 64)}`;
    }
  }
  return `0x${code}`;
}

function references(manifest) {
  return {
    pool: manifest.contracts.pool.address,
    router02: manifest.contracts.router02.address,
    factory: manifest.contracts.factory.address,
    weth: manifest.contracts.weth9.address,
    dUSD: manifest.contracts.dUSD.address,
    pair: manifest.contracts.pair.address,
  };
}

async function poolRecord(client, record) {
  const receipt = await client.getTransactionReceipt({ hash: record.transactionHash });
  if (receipt.status !== 'success' || !same(receipt.contractAddress, record.address) ||
      receipt.blockNumber !== BigInt(record.blockNumber)) throw new Error('Pool deployment receipt mismatch');
  return { address: record.address, txHash: record.transactionHash,
    blockNumber: record.blockNumber, blockHash: receipt.blockHash,
    runtimeSha256: record.runtimeSha256 };
}

function poolReference(manifest) {
  const reference = manifest.references?.poolManifest;
  if (typeof reference?.path !== 'string' || !reference.path ||
      !/^[0-9a-f]{64}$/.test(reference.sha256 ?? '')) throw new Error('Pool manifest reference invalid');
  const bytes = readFileSync(reference.path);
  if (sha256(bytes) !== reference.sha256) throw new Error('Pool manifest hash mismatch');
  return JSON.parse(bytes);
}

async function verifyAdapter(manifest, client, artifact) {
  const record = manifest.contracts.adapter;
  if (!record || !/^0x[0-9a-fA-F]{40}$/.test(record.address ?? '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(record.txHash ?? '')) throw new Error('Adapter deployment record invalid');
  const refs = references(manifest);
  for (const name of referenceNames) {
    if (!same(record[name], refs[name])) throw new Error(`Adapter ${name} reference mismatch`);
  }
  const args = referenceNames.map(name => refs[name]);
  const input = encodeDeployData({ abi: artifact.abi, bytecode: artifact.creationBytecode, args });
  const [transaction, receipt, code] = await Promise.all([
    client.getTransaction({ hash: record.txHash }),
    client.getTransactionReceipt({ hash: record.txHash }),
    client.getCode({ address: record.address }),
  ]);
  if (transaction.to !== null || transaction.input?.toLowerCase() !== input.toLowerCase() ||
      receipt.status !== 'success' || !same(receipt.contractAddress, record.address) ||
      receipt.blockNumber !== BigInt(record.blockNumber) ||
      !same(receipt.blockHash, record.blockHash)) throw new Error('Adapter deployment transaction mismatch');
  const expectedRuntime = adapterRuntimeFor(artifact, refs);
  if (code?.toLowerCase() !== expectedRuntime.toLowerCase() ||
      codeHash(code) !== record.runtimeSha256.toLowerCase()) throw new Error('Adapter runtime mismatch');
  for (const name of referenceNames) {
    const actual = await client.readContract({ address: record.address, abi: artifact.abi, functionName: name });
    if (!same(actual, refs[name])) throw new Error(`Adapter ${name} immutable mismatch`);
  }
}

export async function verifyConnection(manifest, publicClient) {
  if (await publicClient.getChainId() !== manifest?.chainId) throw new Error('chain ID mismatch');
  if (manifest.chainId !== 31337) throw new Error('public chain connection not supported without pinned asset verification');
  const rpcUrl = publicClient.transport?.url;
  if (typeof rpcUrl !== 'string') throw new Error('HTTP RPC URL required for Pool verification');
  const poolManifest = poolReference(manifest);
  if (poolManifest.chainId !== manifest.chainId ||
      !same(poolManifest.pool.address, manifest.contracts?.pool?.address) ||
      !same(poolManifest.verifier.address, manifest.contracts?.verifier?.address)) {
    throw new Error('Pool manifest reference mismatch');
  }
  if (manifest.references.corePoolAddress &&
      same(manifest.references.corePoolAddress, poolManifest.pool.address)) {
    throw new Error('demo Pool must differ from core Pool');
  }
  await verifyDeployment(poolManifest, rpcUrl);
  for (const name of ['pool', 'verifier']) {
    const expected = await poolRecord(publicClient, poolManifest[name]);
    if (JSON.stringify(manifest.contracts[name]) !== JSON.stringify(expected)) {
      throw new Error(`${name} deployment record mismatch`);
    }
  }
  const artifact = loadAdapter();
  await verifyAdapter(manifest, publicClient, artifact);
  await verifyLocalAssets(manifest, publicClient);
}

export async function deployConnection({ poolManifest, poolManifestPath, adapterArtifact, assetManifest,
  signer, publicClient, excludedPoolAddress }) {
  if (!signer?.address || typeof poolManifestPath !== 'string' || !poolManifestPath) {
    throw new Error('signer and saved Pool manifest path required');
  }
  if (await publicClient.getChainId() !== poolManifest.chainId ||
      assetManifest.chainId !== poolManifest.chainId) throw new Error('chain ID mismatch');
  if (poolManifest.chainId !== 31337) throw new Error('public chain connection not supported without pinned asset verification');
  if (!/^0x[0-9a-fA-F]{40}$/.test(excludedPoolAddress ?? '')) {
    throw new Error('core Pool address required');
  }
  if (same(excludedPoolAddress, poolManifest.pool.address)) {
    throw new Error('demo Pool must differ from core Pool');
  }
  const original = readFileSync(poolManifestPath);
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(poolManifest)) {
    throw new Error('Pool manifest input differs from saved file');
  }
  const artifact = loadAdapter();
  if (JSON.stringify(adapterArtifact) !== JSON.stringify(artifact)) {
    throw new Error('Adapter artifact input mismatch');
  }
  const rpcUrl = publicClient.transport?.url;
  if (typeof rpcUrl !== 'string') throw new Error('HTTP RPC URL required for Pool verification');
  await verifyDeployment(poolManifest, rpcUrl);
  await verifyLocalAssets(assetManifest, publicClient);
  const contracts = { ...assetManifest.contracts,
    pool: await poolRecord(publicClient, poolManifest.pool),
    verifier: await poolRecord(publicClient, poolManifest.verifier) };
  const refs = { pool: contracts.pool.address, router02: contracts.router02.address,
    factory: contracts.factory.address, weth: contracts.weth9.address,
    dUSD: contracts.dUSD.address, pair: contracts.pair.address };
  const args = referenceNames.map(name => refs[name]);
  const wallet = createWalletClient({ account: signer, transport: http(rpcUrl) });
  const txHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.creationBytecode,
    args, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Adapter deployment failed');
  const code = await publicClient.getCode({ address: receipt.contractAddress });
  contracts.adapter = { address: receipt.contractAddress, txHash,
    blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
    runtimeSha256: codeHash(code), ...refs };
  const { schemaVersion: _schemaVersion, ...assetFields } = assetManifest;
  const manifest = createUniswapManifest({ ...assetFields, contracts,
    references: { ...assetManifest.references,
      poolManifest: { path: poolManifestPath, sha256: sha256(original) },
      corePoolAddress: excludedPoolAddress } });
  await verifyConnection(manifest, publicClient);
  return manifest;
}
