import { createHash } from 'node:crypto';

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const requiredContracts = ['dUSD', 'router02', 'factory', 'weth9', 'pair'];
const knownKeys = new Set(['chainId', 'generation', 'contracts', 'assets', 'site', 'provenance', 'references']);

const sha256Code = code => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
const sameAddress = (left, right) => left?.toLowerCase() === right?.toLowerCase();

const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const routerAbi = [
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'WETH', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const factoryAbi = [{ type: 'function', name: 'getPair', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] }];
const pairAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [
    { type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' },
  ] },
];

function rejectSecrets(value, key = '') {
  if (/secret|private.?key|password|api.?key|authorization|bearer|rpc.?url/i.test(key)) {
    throw new Error(`secret field forbidden: ${key}`);
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(k =>
        /key|secret|token|auth|password|credential/i.test(k))) {
        throw new Error('URL credential forbidden in public manifest');
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(item => rejectSecrets(item, key));
  } else if (value && typeof value === 'object') {
    for (const [child, content] of Object.entries(value)) rejectSecrets(content, child);
  }
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0 ||
      typeof manifest.generation !== 'string' || !manifest.generation) {
    throw new Error('manifest schema, chain or generation invalid');
  }
  if (!manifest.contracts || !manifest.assets || !manifest.provenance || !manifest.references) {
    throw new Error('manifest fields missing');
  }
  for (const name of requiredContracts) {
    const contract = manifest.contracts[name];
    if (!address.test(contract?.address ?? '') || !/^[0-9a-fA-F]{64}$/.test(contract?.runtimeSha256 ?? '') ||
        !hash.test(contract?.txHash ?? '') || !decimal.test(contract?.blockNumber ?? '') ||
        !hash.test(contract?.blockHash ?? '')) {
      throw new Error(`${name} deployment record invalid`);
    }
  }
  const connectionNames = ['pool', 'verifier', 'adapter'];
  if (connectionNames.some(name => name in manifest.contracts)) {
    for (const name of connectionNames) {
      const contract = manifest.contracts[name];
      if (!address.test(contract?.address ?? '') || !/^[0-9a-fA-F]{64}$/.test(contract?.runtimeSha256 ?? '') ||
          !hash.test(contract?.txHash ?? '') || !decimal.test(contract?.blockNumber ?? '') ||
          !hash.test(contract?.blockHash ?? '')) {
        throw new Error(`${name} deployment record invalid`);
      }
    }
    const ref = manifest.references.poolManifest;
    if (typeof ref?.path !== 'string' || !ref.path || !/^[0-9a-fA-F]{64}$/.test(ref.sha256 ?? '') ||
        !address.test(manifest.references.corePoolAddress ?? '')) {
      throw new Error('Pool manifest reference invalid');
    }
    for (const name of ['pool', 'router02', 'factory', 'weth', 'dUSD', 'pair']) {
      if (!address.test(manifest.contracts.adapter[name] ?? '')) {
        throw new Error(`Adapter ${name} reference invalid`);
      }
    }
  }
  const { dUSD, liquidity, checkpoint } = manifest.assets;
  if (dUSD?.decimals !== 18 || dUSD?.totalSupply !== '1000000000000000000000000' ||
      !address.test(dUSD?.initialHolder ?? '') || !address.test(dUSD?.remainingHolder ?? '') ||
      !address.test(liquidity?.lpRecipient ?? '') ||
      liquidity?.initialWethWei !== '100000000000000000' ||
      liquidity?.initialDusdUnits !== '10000000000000000000000' ||
      !decimal.test(checkpoint?.blockNumber ?? '') || !hash.test(checkpoint?.blockHash ?? '') ||
      !decimal.test(checkpoint?.reserve0 ?? '') || !decimal.test(checkpoint?.reserve1 ?? '')) {
    throw new Error('asset record invalid');
  }
  rejectSecrets(manifest);
}

export function createUniswapManifest(input) {
  if (Object.keys(input).some(key => !knownKeys.has(key))) {
    throw new Error('secret or unknown manifest field');
  }
  const manifest = structuredClone({ schemaVersion: 1, ...input });
  validateManifest(manifest);
  return manifest;
}

export async function verifyUniswapManifest(manifest, publicClient) {
  validateManifest(manifest);
  if (await publicClient.getChainId() !== manifest.chainId) throw new Error('chain ID mismatch');
  for (const [name, contract] of Object.entries(manifest.contracts)) {
    if (!address.test(contract.address) || !/^[0-9a-fA-F]{64}$/.test(contract.runtimeSha256)) {
      throw new Error(`${name} deployment record invalid`);
    }
    const code = await publicClient.getCode({ address: contract.address });
    if (!code || sha256Code(code) !== contract.runtimeSha256.toLowerCase()) {
      throw new Error(`${name} runtime hash mismatch`);
    }
    const block = await publicClient.getBlock({ blockNumber: BigInt(contract.blockNumber) });
    if (block.hash?.toLowerCase() !== contract.blockHash.toLowerCase()) {
      throw new Error(`${name} block hash mismatch`);
    }
  }
  const { dUSD, router02, factory, weth9, pair } = manifest.contracts;
  const read = (target, abi, functionName, args = [], blockNumber) =>
    publicClient.readContract({ address: target.address, abi, functionName, args,
      ...(blockNumber === undefined ? {} : { blockNumber }) });
  if (!sameAddress(await read(router02, routerAbi, 'factory'), factory.address)) throw new Error('Router factory mismatch');
  if (!sameAddress(await read(router02, routerAbi, 'WETH'), weth9.address)) throw new Error('Router WETH mismatch');
  if (!sameAddress(await read(factory, factoryAbi, 'getPair', [weth9.address, dUSD.address]), pair.address)) {
    throw new Error('Factory pair mismatch');
  }
  if (Number(await read(dUSD, erc20Abi, 'decimals')) !== manifest.assets.dUSD.decimals ||
      String(await read(dUSD, erc20Abi, 'totalSupply')) !== manifest.assets.dUSD.totalSupply) {
    throw new Error('dUSD asset mismatch');
  }
  const checkpoint = manifest.assets.checkpoint;
  const checkpointBlock = await publicClient.getBlock({ blockNumber: BigInt(checkpoint.blockNumber) });
  if (checkpointBlock.hash?.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
    throw new Error('reserve block hash mismatch');
  }
  const token0 = await read(pair, pairAbi, 'token0');
  const token1 = await read(pair, pairAbi, 'token1');
  const expected = [dUSD.address, weth9.address].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()));
  if (!sameAddress(token0, expected[0]) || !sameAddress(token1, expected[1])) {
    throw new Error('Pair token order mismatch');
  }
  const reserves = await read(pair, pairAbi, 'getReserves', [], BigInt(checkpoint.blockNumber));
  if (String(reserves[0]) !== checkpoint.reserve0 || String(reserves[1]) !== checkpoint.reserve1) {
    throw new Error('Pair reserve mismatch');
  }
}
