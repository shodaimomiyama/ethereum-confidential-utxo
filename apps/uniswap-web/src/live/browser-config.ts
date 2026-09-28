import { createEthereumRpc, verifyEthereumDeployment, type VerifiedDeployment, type RpcConnection } from '@confidential-utxo/ethereum';
import { adapterAbi, type Address, type DeploymentId } from '@confidential-utxo/uniswap';
import { erc20Abi, sha256, toBytes, type Abi } from 'viem';
import uniswapV2 from '../../../../packages/ethereum/generated/uniswap-v2.json' with { type: 'json' };
import adapterArtifact from '../../../../packages/ethereum/generated/uniswap-payment-v1.json' with { type: 'json' };
import { createDeploymentResolver, type BrowserDeployment, type ServiceDeploymentConfig } from './deployment.js';
import type { PreparationDeployment } from './payment-preparation.js';

export interface LoadedBrowserLiveConfig {
  readonly browser: BrowserDeployment;
  readonly verified: VerifiedDeployment;
  readonly rpc: RpcConnection;
  readonly deployment: PreparationDeployment;
  readonly resolveBrowser: ReturnType<typeof createDeploymentResolver>;
  readonly resolveVerified: (id: DeploymentId) => VerifiedDeployment | undefined;
  readonly resolveDeployment: (id: DeploymentId) => PreparationDeployment | undefined;
}

type JsonObject = Record<string, unknown>;
const names = ['pool', 'verifier', 'adapter', 'dUSD', 'router02', 'factory', 'weth9', 'pair'] as const;
type ContractName = typeof names[number];
type ContractRecord = { address: Address; runtimeSha256: string; txHash: `0x${string}`;
  blockNumber: string; blockHash: `0x${string}`; [key: string]: unknown };
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const digestPattern = /^[0-9a-fA-F]{64}$/;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
function invalid(): never { throw new Error('INVALID_LIVE_CONFIG'); }
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonObject;
}
function address(value: unknown): Address {
  if (typeof value !== 'string' || !addressPattern.test(value) || /^0x0{40}$/i.test(value)) invalid();
  return value as Address;
}
function hash(value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !hashPattern.test(value)) invalid();
  return value as `0x${string}`;
}
function contract(value: unknown): ContractRecord {
  const data = object(value);
  const result: ContractRecord = { ...data, address: address(data.address),
    runtimeSha256: String(data.runtimeSha256), txHash: hash(data.txHash),
    blockNumber: String(data.blockNumber), blockHash: hash(data.blockHash) };
  if (!digestPattern.test(result.runtimeSha256) || typeof data.blockNumber !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(data.blockNumber)) invalid();
  return result;
}
function parsedConfig(value: unknown) {
  const data = object(value);
  const connection = object(data.connectionManifest);
  const contracts = object(connection.contracts);
  const records = Object.fromEntries(names.map(name => [name, contract(contracts[name])])) as Record<ContractName, ContractRecord>;
  const site = object(connection.site);
  const references = object(connection.references);
  const assets = object(connection.assets);
  const token = object(assets.dUSD);
  const checkpoint = object(assets.checkpoint);
  hash(checkpoint.blockHash);
  const provenance = object(connection.provenance);
  const catalogue = object(data.serviceCatalogue) as Record<string, ServiceDeploymentConfig>;
  if (data.schemaVersion !== 1 || connection.schemaVersion !== 1 || data.finalityMode !== 'local-simulated'
    || connection.chainId !== 31337 || typeof data.deploymentId !== 'string' || !data.deploymentId
    || typeof data.rpcUrl !== 'string' || !Object.hasOwn(catalogue, data.deploymentId)
    || site.deploymentId !== data.deploymentId || same(address(references.corePoolAddress), records.pool.address)
    || !same(records.pool.address, address(object(contracts.adapter).pool))
    || token.decimals !== 18 || token.totalSupply !== '1000000000000000000000000'
    || typeof checkpoint.blockNumber !== 'string' || !/^(0|[1-9][0-9]*)$/.test(checkpoint.blockNumber)
    || typeof checkpoint.reserve0 !== 'string' || !/^(0|[1-9][0-9]*)$/.test(checkpoint.reserve0)
    || typeof checkpoint.reserve1 !== 'string' || !/^(0|[1-9][0-9]*)$/.test(checkpoint.reserve1)
    || provenance.uniswapSourceLockSha256 !== uniswapV2.provenance.sourceLockSha256
    || provenance.uniswapArtifactPairHash !== uniswapV2.pairInitCodeHash) invalid();
  const refs = object(contracts.adapter);
  const expected = { pool: records.pool.address, router02: records.router02.address,
    factory: records.factory.address, weth: records.weth9.address, dUSD: records.dUSD.address,
    pair: records.pair.address };
  for (const [name, value] of Object.entries(expected)) if (!same(address(refs[name]), value)) invalid();
  return { data, connection, records, assets: { token, checkpoint }, catalogue,
    deploymentId: data.deploymentId as DeploymentId, rpcUrl: data.rpcUrl,
    coreManifest: data.coreManifest };
}

function expectedAdapterRuntime(records: Record<ContractName, ContractRecord>): string {
  const adapter = object(adapterArtifact.ast);
  if (!Array.isArray(adapter.nodes)) invalid();
  const definition = adapter.nodes.map(object).find(node => node.nodeType === 'ContractDefinition'
    && node.name === 'UniswapPaymentAdapter');
  if (!definition || !Array.isArray(definition.nodes)) invalid();
  const declarations = definition.nodes.map(object).filter(node => node.nodeType === 'VariableDeclaration'
    && node.mutability === 'immutable');
  const ids = new Map(declarations.map(node => [node.name, String(node.id)]));
  const references = adapterArtifact.immutableReferences as Record<string, readonly { start: number; length: number }[]>;
  const targets = { pool: records.pool.address, router02: records.router02.address,
    factory: records.factory.address, weth: records.weth9.address, dUSD: records.dUSD.address,
    pair: records.pair.address };
  if (ids.size !== 6 || Object.keys(references).length !== 6) invalid();
  let code = adapterArtifact.runtimeBytecode.slice(2).toLowerCase();
  for (const [name, target] of Object.entries(targets)) {
    const id = ids.get(name);
    const locations = id === undefined ? undefined : references[id];
    if (!locations?.length) invalid();
    const word = target.slice(2).toLowerCase().padStart(64, '0');
    for (const item of locations) {
      if (!Number.isSafeInteger(item.start) || item.length !== 32
        || item.start * 2 + 64 > code.length) invalid();
      code = `${code.slice(0, item.start * 2)}${word}${code.slice(item.start * 2 + 64)}`;
    }
  }
  return `0x${code}`;
}

async function verifyConnection(input: ReturnType<typeof parsedConfig>, rpc: RpcConnection,
  verified: VerifiedDeployment): Promise<void> {
  const { records, assets } = input;
  const client = rpc.client;
  if (await client.getChainId() !== 31337 || verified.context.chainId !== 31337n
    || verified.context.finalityMode !== 'local-simulated'
    || !same(verified.context.pool, records.pool.address)
    || !same(verified.manifest.pool.address, records.pool.address)) invalid();
  for (const name of names) {
    const item = records[name];
    const code = await client.getCode({ address: item.address });
    if (!code || !same(sha256(toBytes(code)).slice(2), item.runtimeSha256)) invalid();
    if (name === 'adapter' && !same(code, expectedAdapterRuntime(records))) invalid();
    const block = await client.getBlock({ blockNumber: BigInt(item.blockNumber) });
    if (!block.hash || !same(block.hash, item.blockHash)) invalid();
    if (name === 'weth9' || name === 'factory' || name === 'pair') {
      const artifact = uniswapV2.artifacts[name as keyof typeof uniswapV2.artifacts];
      if (!same(item.runtimeSha256, artifact.runtimeSha256)) invalid();
    }
  }
  const adapterReceipt = await client.getTransactionReceipt({ hash: records.adapter.txHash });
  if (adapterReceipt.status !== 'success' || !adapterReceipt.contractAddress
    || !same(adapterReceipt.contractAddress, records.adapter.address)
    || adapterReceipt.blockNumber !== BigInt(records.adapter.blockNumber)
    || !same(adapterReceipt.blockHash, records.adapter.blockHash)) invalid();
  const expected = { pool: records.pool.address, router02: records.router02.address,
    factory: records.factory.address, weth: records.weth9.address, dUSD: records.dUSD.address,
    pair: records.pair.address };
  for (const [name, target] of Object.entries(expected)) {
    const actual = await client.readContract({ address: records.adapter.address, abi: adapterAbi,
      functionName: name as 'pool' });
    if (!same(String(actual), target)) invalid();
  }
  const routerAbi = uniswapV2.artifacts.router02.abi as unknown as Abi;
  const factoryAbi = uniswapV2.artifacts.factory.abi as unknown as Abi;
  const pairAbi = uniswapV2.artifacts.pair.abi as unknown as Abi;
  const routerFactory = await client.readContract({ address: records.router02.address, abi: routerAbi, functionName: 'factory' });
  const routerWeth = await client.readContract({ address: records.router02.address, abi: routerAbi, functionName: 'WETH' });
  const pair = await client.readContract({ address: records.factory.address, abi: factoryAbi,
    functionName: 'getPair', args: [records.weth9.address, records.dUSD.address] });
  if (!same(String(routerFactory), records.factory.address) || !same(String(routerWeth), records.weth9.address)
    || !same(String(pair), records.pair.address)) invalid();
  const decimals = await client.readContract({ address: records.dUSD.address, abi: erc20Abi, functionName: 'decimals' });
  const supply = await client.readContract({ address: records.dUSD.address, abi: erc20Abi, functionName: 'totalSupply' });
  if (Number(decimals) !== 18 || String(supply) !== assets.token.totalSupply) invalid();
  const token0 = await client.readContract({ address: records.pair.address, abi: pairAbi, functionName: 'token0' });
  const token1 = await client.readContract({ address: records.pair.address, abi: pairAbi, functionName: 'token1' });
  const sorted = [records.dUSD.address, records.weth9.address].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (!same(String(token0), sorted[0]!) || !same(String(token1), sorted[1]!)) invalid();
  const point = await client.getBlock({ blockNumber: BigInt(assets.checkpoint.blockNumber as string) });
  if (!point.hash || !same(point.hash, hash(assets.checkpoint.blockHash))) invalid();
  const reserves = await client.readContract({ address: records.pair.address, abi: pairAbi,
    functionName: 'getReserves', blockNumber: BigInt(assets.checkpoint.blockNumber as string) });
  if (!Array.isArray(reserves) || String(reserves[0]) !== assets.checkpoint.reserve0
    || String(reserves[1]) !== assets.checkpoint.reserve1) invalid();
}

export async function loadBrowserLiveConfig(input: { readonly url: string; readonly expectedSha256: string }): Promise<LoadedBrowserLiveConfig> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.expectedSha256)) throw new Error('INVALID_LIVE_CONFIG');
  let url: URL;
  try { url = new URL(input.url, location.href); }
  catch { throw new Error('INVALID_LIVE_CONFIG'); }
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) throw new Error('INVALID_LIVE_CONFIG');
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || response.redirected || response.url !== url.href) throw new Error('INVALID_LIVE_CONFIG');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 1_048_576) throw new Error('INVALID_LIVE_CONFIG');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== input.expectedSha256.toLowerCase()) throw new Error('LIVE_CONFIG_HASH_MISMATCH');
  let parsed: ReturnType<typeof parsedConfig>;
  try { parsed = parsedConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new Error('INVALID_LIVE_CONFIG'); }
  const rpc = createEthereumRpc({ url: parsed.rpcUrl, mode: 'local-simulated' });
  const verified = await verifyEthereumDeployment(rpc.client, parsed.coreManifest, 'local-simulated');
  await verifyConnection(parsed, rpc, verified);
  const evidence = { deploymentId: parsed.deploymentId, generation: String(parsed.connection.generation),
    chainId: 31337, pool: parsed.records.pool.address, adapter: parsed.records.adapter.address };
  const resolveBrowser = createDeploymentResolver({ readManifest: () => parsed.connection,
    verified: evidence, catalogue: parsed.catalogue });
  const browser = resolveBrowser(parsed.deploymentId);
  if (!browser || browser.origin !== location.origin) invalid();
  const deployment: PreparationDeployment = { chainId: 31337n, pool: parsed.records.pool.address,
    adapter: parsed.records.adapter.address, token: parsed.records.dUSD.address,
    router: parsed.records.router02.address, factory: parsed.records.factory.address,
    weth: parsed.records.weth9.address, pair: parsed.records.pair.address };
  return { browser, verified, rpc, deployment, resolveBrowser,
    resolveVerified: id => id === parsed.deploymentId ? verified : undefined,
    resolveDeployment: id => id === parsed.deploymentId ? deployment : undefined };
}
