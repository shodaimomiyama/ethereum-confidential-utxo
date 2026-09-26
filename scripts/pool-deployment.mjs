import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, encodeAbiParameters, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifactPath, outputPath, verifyPoolRecord } from './pool-artifact.mjs';
import { artifactPath as verifierArtifactPath, outputPath as verifierOutputPath,
  verifyVerifierRecord, constructorArgs, parameters, sha256, hexBytes } from './verifier-artifact.mjs';

const MAX_RUNTIME = 24576;
const MAX_INITCODE = 49152;
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const lower = value => value.toLowerCase();
const word = address => address.slice(2).toLowerCase().padStart(64, '0');

export function loadArtifacts() {
  const poolArtifact = load(artifactPath);
  const pool = verifyPoolRecord(load(outputPath), poolArtifact);
  const verifierArtifact = load(verifierArtifactPath);
  const verifier = verifyVerifierRecord(load(verifierOutputPath), verifierArtifact, { requireMeasurements: false });
  return { pool, verifier };
}

export function poolRuntimeFor(pool, verifierAddress) {
  let hex = pool.runtimeBytecode.slice(2).toLowerCase();
  const refs = Object.values(pool.immutableReferences ?? {}).flat();
  if (refs.length === 0 || refs.some(item => item.length !== 32)) throw new Error('Pool verifier immutable references missing');
  for (const ref of refs) {
    const offset = ref.start * 2;
    hex = hex.slice(0, offset) + word(verifierAddress) + hex.slice(offset + 64);
  }
  return `0x${hex}`;
}

function enforceCodeLimits(initcode, runtime, blockGasLimit) {
  if (hexBytes(runtime, 'runtime').length > MAX_RUNTIME || hexBytes(initcode, 'initcode').length > MAX_INITCODE) {
    throw new Error('EIP-170/3860 code size exceeded');
  }
  if (blockGasLimit <= 0n) throw new Error('invalid block gas limit');
}

async function verifierState(client, address, verifier) {
  const read = (functionName, args = []) => client.readContract({ address, abi: verifier.abi, functionName, args });
  const hash = await read('parametersHash');
  if (lower(hash) !== lower(verifier.parametersHash)) throw new Error('verifier parameter hash mismatch');
  const [base, gs, hs] = parameters();
  for (const [name, expected] of [['valueBase', base.slice(0, 2)], ['blindingBase', base.slice(2, 4)]]) {
    const actual = await read(name);
    if (actual[0] !== expected[0] || actual[1] !== expected[1]) throw new Error(`verifier ${name} mismatch`);
  }
  for (let i = 0; i < 64; ++i) {
    for (const [name, expected] of [['gs', gs], ['hs', hs]]) {
      const actual = await read(name, [BigInt(i)]);
      if (actual[0] !== expected[i] || actual[1] !== expected[i + 64]) {
        throw new Error(`verifier ${name}[${i}] mismatch`);
      }
    }
  }
}

async function transactionEvidence(client, address, expectedInput, expectedRuntime) {
  const code = await client.getCode({ address });
  if (lower(code ?? '0x') !== lower(expectedRuntime)) throw new Error('deployed runtime mismatch');
  const receipt = await client.getTransactionReceipt({ hash: await findCreationHash(client, address) });
  if (receipt.status !== 'success' || lower(receipt.contractAddress ?? '') !== lower(address)) {
    throw new Error('deployment receipt mismatch');
  }
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  if (tx.to !== null || lower(tx.input) !== lower(expectedInput)) throw new Error('constructor transaction mismatch');
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.gasUsed > block.gasLimit) throw new Error('deployment exceeds block gas limit');
  return { address, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(), blockGasLimit: block.gasLimit.toString(),
    runtimeSha256: sha256(hexBytes(code, 'deployed runtime')),
    initcodeSha256: sha256(hexBytes(expectedInput, 'constructor input')) };
}

// The transaction hash is passed through this map during deployment, and from the manifest on recheck.
const creationHashes = new Map();
async function findCreationHash(_client, address) {
  const hash = creationHashes.get(lower(address));
  if (!hash) throw new Error('creation transaction hash missing');
  return hash;
}

export async function verifyDeployment(manifest, rpcUrl, artifacts = loadArtifacts()) {
  if (manifest?.schemaVersion !== 1 || !Number.isInteger(manifest.chainId) || !manifest.verifier || !manifest.pool ||
      typeof manifest.hardfork !== 'string' || !manifest.hardfork ||
      typeof manifest.tool?.node !== 'string' || typeof manifest.tool?.forge !== 'string') {
    throw new Error('deployment manifest malformed');
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== manifest.chainId) throw new Error('chain ID mismatch');
  const { pool, verifier } = artifacts;
  if (manifest.artifacts.pool !== pool.manifest.runtimeSha256 ||
      manifest.artifacts.verifier !== verifier.manifest.runtimeSha256 ||
      manifest.parametersHash !== verifier.parametersHash) throw new Error('artifact or parameter identity mismatch');
  creationHashes.set(lower(manifest.verifier.address), manifest.verifier.transactionHash);
  creationHashes.set(lower(manifest.pool.address), manifest.pool.transactionHash);
  const verifierInput = `${verifier.creationBytecode}${constructorArgs().slice(2)}`;
  const verifierEvidence = await transactionEvidence(client, manifest.verifier.address,
    verifierInput, verifier.runtimeBytecode);
  await verifierState(client, manifest.verifier.address, verifier);
  const poolArgs = encodeAbiParameters([{ type: 'address' }], [manifest.verifier.address]);
  const poolInput = `${pool.creationBytecode}${poolArgs.slice(2)}`;
  const expectedPoolRuntime = poolRuntimeFor(pool, manifest.verifier.address);
  const poolEvidence = await transactionEvidence(client, manifest.pool.address, poolInput, expectedPoolRuntime);
  const reference = await client.readContract({ address: manifest.pool.address, abi: pool.abi, functionName: 'verifier' });
  if (lower(reference) !== lower(manifest.verifier.address)) throw new Error('Pool verifier reference mismatch');
  for (const [label, recorded, actual] of [['verifier', manifest.verifier, verifierEvidence], ['pool', manifest.pool, poolEvidence]]) {
    for (const key of Object.keys(actual)) {
      if (lower(String(recorded[key] ?? '')) !== lower(String(actual[key]))) throw new Error(`${label} ${key} mismatch`);
    }
  }
  if (manifest.pool.constructorArgsSha256 !== sha256(hexBytes(poolArgs, 'Pool args')) ||
      manifest.verifier.constructorArgsSha256 !== sha256(hexBytes(constructorArgs(), 'verifier args'))) {
    throw new Error('constructor arguments hash mismatch');
  }
  return { chainId, verifier: verifierEvidence, pool: poolEvidence };
}

export async function deployPool({ rpcUrl, expectedChainId, privateKey, hardfork }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) throw new Error('explicit private key required');
  if (typeof hardfork !== 'string' || !hardfork) throw new Error('explicit hardfork label required');
  const { pool, verifier } = loadArtifacts();
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) throw new Error('wrong chain ID for deployment');
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  const block = await client.getBlock();
  const deploy = async (initcode, runtime) => {
    enforceCodeLimits(initcode, runtime, block.gasLimit);
    const gas = await client.estimateGas({ account: account.address, data: initcode });
    if (gas > block.gasLimit) throw new Error('deployment gas exceeds block limit');
    const hash = await wallet.sendTransaction({ to: undefined, data: initcode, gas });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deployment failed');
    creationHashes.set(lower(receipt.contractAddress), hash);
    return receipt.contractAddress;
  };
  const verifierArgs = constructorArgs();
  const verifierAddress = await deploy(`${verifier.creationBytecode}${verifierArgs.slice(2)}`,
    verifier.runtimeBytecode);
  const poolArgs = encodeAbiParameters([{ type: 'address' }], [verifierAddress]);
  const poolAddress = await deploy(`${pool.creationBytecode}${poolArgs.slice(2)}`, poolRuntimeFor(pool, verifierAddress));
  const manifest = {
    schemaVersion: 1, chainId, hardfork, signer: account.address,
    tool: { node: process.version, forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0] },
    artifacts: { pool: pool.manifest.runtimeSha256, verifier: verifier.manifest.runtimeSha256 },
    parametersHash: verifier.parametersHash,
    verifier: { ...(await transactionEvidence(client, verifierAddress,
      `${verifier.creationBytecode}${verifierArgs.slice(2)}`, verifier.runtimeBytecode)),
      constructorArgsSha256: sha256(hexBytes(verifierArgs, 'verifier args')) },
    pool: { ...(await transactionEvidence(client, poolAddress,
      `${pool.creationBytecode}${poolArgs.slice(2)}`, poolRuntimeFor(pool, verifierAddress))),
      constructorArgsSha256: sha256(hexBytes(poolArgs, 'Pool args')) },
  };
  await verifyDeployment(manifest, rpcUrl, { pool, verifier });
  return manifest;
}
