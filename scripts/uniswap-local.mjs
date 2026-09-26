import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { createUniswapManifest, verifyUniswapManifest } from './uniswap-manifest.mjs';

const localChainId = 31337;
const wethWei = 100000000000000000n;
const dusdUnits = 10000000000000000000000n;
const sha256 = code => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
const address = /^0x[0-9a-fA-F]{40}$/;

const bundlePath = 'packages/ethereum/generated/uniswap-v2.json';
const dusdPath = 'contracts/out/DemoUSD.sol/DemoUSD.json';

function loadArtifacts() {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const dusd = JSON.parse(readFileSync(dusdPath, 'utf8'));
  return { bundle, dusd: { abi: dusd.abi, creationBytecode: dusd.bytecode.object } };
}

function validateInput(input) {
  if (input.chainId !== localChainId) throw new Error('local deployment chain ID must be 31337');
  if (!input.generation || typeof input.generation !== 'string') throw new Error('generation missing');
  if (!address.test(input.holder ?? '') || !address.test(input.lpRecipient ?? '')) {
    throw new Error('holder and LP recipient addresses required');
  }
  const parsed = new URL(input.url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('local RPC URL must use loopback');
  }
  if (parsed.username || parsed.password || parsed.search) throw new Error('local RPC URL credentials forbidden');
  if (input.rewardFundingWei && BigInt(input.rewardFundingWei) > 0n) {
    throw new Error('reward funding requires the formal Pool; asset-only deployment cannot fund it');
  }
}

async function deploymentRecord(client, receipt) {
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('contract deployment failed');
  const code = await client.getCode({ address: receipt.contractAddress });
  if (!code || code === '0x') throw new Error('deployed code missing');
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return {
    address: receipt.contractAddress,
    runtimeSha256: sha256(code),
    txHash: receipt.transactionHash,
    blockNumber: String(receipt.blockNumber),
    blockHash: block.hash,
  };
}

async function awaitTransaction(client, hash) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return receipt;
}

export async function verifyLocalAssets(manifest, publicClient) {
  if (manifest.chainId !== localChainId) throw new Error('local manifest chain ID mismatch');
  return verifyUniswapManifest(manifest, publicClient);
}

export async function captureLocalSnapshot({ publicClient, manifest }) {
  if (await publicClient.getChainId() !== localChainId || manifest.chainId !== localChainId) {
    throw new Error('snapshot chain ID must be local Anvil');
  }
  if (manifest.site !== null) throw new Error('asset-only snapshot requires no active service');
  await verifyLocalAssets(manifest, publicClient);
  const block = await publicClient.getBlock();
  const snapshotId = await publicClient.request({ method: 'evm_snapshot', params: [] });
  return { snapshotId, generation: manifest.generation, chainId: localChainId,
    reserveBlockHash: block.hash };
}

export async function restoreLocalSnapshot(snapshot, { publicClient, manifest, serviceState = null }) {
  if (await publicClient.getChainId() !== localChainId || manifest.chainId !== localChainId ||
      snapshot.chainId !== localChainId) throw new Error('reset chain ID must be local Anvil');
  if (snapshot.generation !== manifest.generation) throw new Error('snapshot generation mismatch');
  if (serviceState !== null || manifest.site !== null) {
    throw new Error('service reservations require DO stop and reset before whole-environment restore');
  }
  const reverted = await publicClient.request({ method: 'evm_revert', params: [snapshot.snapshotId] });
  if (reverted !== true) throw new Error('Anvil snapshot no longer exists');
  const restoredBlock = await publicClient.getBlock();
  if (restoredBlock.hash?.toLowerCase() !== snapshot.reserveBlockHash.toLowerCase()) {
    throw new Error('restored block hash mismatch');
  }
  await verifyLocalAssets(manifest, publicClient);
  return captureLocalSnapshot({ publicClient, manifest });
}

export async function deployLocalAssets(input) {
  validateInput(input);
  const client = createPublicClient({ transport: http(input.url) });
  if (await client.getChainId() !== localChainId) throw new Error('RPC chain ID mismatch');
  if (input.existingManifest) {
    if (input.existingManifest.generation !== input.generation ||
        input.existingManifest.assets.dUSD.initialHolder.toLowerCase() !== input.holder.toLowerCase() ||
        input.existingManifest.assets.liquidity.lpRecipient.toLowerCase() !== input.lpRecipient.toLowerCase()) {
      throw new Error('existing deployment configuration mismatch');
    }
    await verifyLocalAssets(input.existingManifest, client);
    return input.existingManifest;
  }
  const wallet = createWalletClient({ account: input.holder, transport: http(input.url) });
  const { bundle, dusd } = loadArtifacts();
  const artifacts = bundle.artifacts;
  const contracts = {};
  async function deploy(name, artifact, args = []) {
    let hash;
    try {
      hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.creationBytecode, args, chain: null });
    } catch (error) {
      throw new Error(`deployment ${name} result uncertain; inspect sender nonce and code before retry`, { cause: error });
    }
    contracts[name] = await deploymentRecord(client, await awaitTransaction(client, hash));
  }
  await deploy('weth9', artifacts.weth9);
  await deploy('factory', artifacts.factory, [input.holder]);
  await deploy('router02', artifacts.router02, [contracts.factory.address, contracts.weth9.address]);
  await deploy('dUSD', dusd, [input.holder]);

  const token = contracts.dUSD.address;
  const router = contracts.router02.address;
  const approved = await wallet.writeContract({ address: token, abi: dusd.abi,
    functionName: 'approve', args: [router, dusdUnits], chain: null });
  await awaitTransaction(client, approved);
  const block = await client.getBlock();
  let liquidityHash;
  try {
    liquidityHash = await wallet.writeContract({ address: router, abi: artifacts.router02.abi,
      functionName: 'addLiquidityETH',
      args: [token, dusdUnits, dusdUnits, wethWei, input.lpRecipient, block.timestamp + 300n],
      value: wethWei, chain: null });
  } catch (error) {
    throw new Error('liquidity result uncertain; inspect Pair and sender nonce before retry', { cause: error });
  }
  const liquidityReceipt = await awaitTransaction(client, liquidityHash);
  const pairAddress = await client.readContract({ address: contracts.factory.address, abi: artifacts.factory.abi,
    functionName: 'getPair', args: [contracts.weth9.address, token] });
  if (!address.test(pairAddress) || /^0x0+$/i.test(pairAddress)) throw new Error('Pair not created');
  const pairCode = await client.getCode({ address: pairAddress });
  if (!pairCode || pairCode === '0x') throw new Error('Pair code missing');
  const liquidityBlock = await client.getBlock({ blockNumber: liquidityReceipt.blockNumber });
  contracts.pair = {
    address: pairAddress, runtimeSha256: sha256(pairCode), txHash: liquidityHash,
    blockNumber: String(liquidityReceipt.blockNumber), blockHash: liquidityBlock.hash,
  };
  const reserves = await client.readContract({ address: pairAddress, abi: artifacts.pair.abi,
    functionName: 'getReserves', blockNumber: liquidityReceipt.blockNumber });
  const manifest = createUniswapManifest({
    chainId: localChainId, generation: input.generation, contracts,
    assets: {
      dUSD: { decimals: 18, totalSupply: '1000000000000000000000000',
        initialHolder: input.holder, remainingHolder: input.holder },
      liquidity: { lpRecipient: input.lpRecipient, initialWethWei: String(wethWei),
        initialDusdUnits: String(dusdUnits), transactionHash: liquidityHash },
      checkpoint: { blockNumber: String(liquidityReceipt.blockNumber), blockHash: liquidityBlock.hash,
        reserve0: String(reserves[0]), reserve1: String(reserves[1]) },
    },
    site: null,
    provenance: { uniswapSourceLockSha256: bundle.provenance.sourceLockSha256,
      uniswapArtifactPairHash: bundle.pairInitCodeHash },
    references: {},
  });
  await verifyLocalAssets(manifest, client);
  return manifest;
}

export function beginLocalDeployment(path, input) {
  if (existsSync(`${path}.attempt.json`)) throw new Error('deployment attempt pending; inspect chain before retry');
  if (existsSync(path)) throw new Error('manifest already exists; verify it instead of redeploying');
  const record = {
    chainId: input.chainId,
    generation: input.generation,
    holder: input.holder,
    lpRecipient: input.lpRecipient ?? null,
    status: 'submission-outcome-unknown-until-complete',
  };
  writeFileSync(`${path}.attempt.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function completeLocalDeployment(path, manifest) {
  if (!existsSync(`${path}.attempt.json`)) throw new Error('deployment attempt record missing');
  if (existsSync(path)) throw new Error('manifest already exists');
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  unlinkSync(`${path}.attempt.json`);
}

function parseArgs(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || !argv[index + 1]) throw new Error(`invalid argument ${key}`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const help = action === '--help' || process.argv.slice(3).includes('--help');
  if (help ||
      !['deploy', 'verify', 'snapshot', 'reset'].includes(action)) {
    console.log('usage: node scripts/uniswap-local.mjs deploy|verify|snapshot|reset --rpc-url URL --chain-id 31337 --manifest PATH [--generation ID --holder ADDRESS --lp-recipient ADDRESS] [--snapshot PATH]');
    if (!help) process.exitCode = 1;
  } else {
    const options = parseArgs(process.argv.slice(3));
    const file = options.manifest;
    if (!file) throw new Error('manifest path required');
    const url = options['rpc-url'];
    const chainId = Number(options['chain-id']);
    if (action === 'verify') {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (chainId !== manifest.chainId) throw new Error('requested chain differs from manifest');
      await verifyLocalAssets(manifest, createPublicClient({ transport: http(url) }));
      console.log(`Local assets verified: ${file}`);
    } else if (action === 'snapshot' || action === 'reset') {
      const snapshotPath = options.snapshot;
      if (!snapshotPath) throw new Error('snapshot path required');
      if (options.scope && options.scope !== 'assets') {
        throw new Error('whole-environment reset requires DO integration');
      }
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (chainId !== manifest.chainId) throw new Error('requested chain differs from manifest');
      const publicClient = createPublicClient({ transport: http(url) });
      if (action === 'snapshot') {
        if (existsSync(snapshotPath)) throw new Error('snapshot file already exists');
        const snapshot = await captureLocalSnapshot({ publicClient, manifest });
        writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
        console.log(`Local snapshot captured: ${snapshotPath}`);
      } else {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        const next = await restoreLocalSnapshot(snapshot, { publicClient, manifest });
        writeFileSync(snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Local assets restored: ${snapshotPath}`);
      }
    } else {
      const input = { url, chainId, generation: options.generation,
        holder: options.holder, lpRecipient: options['lp-recipient'],
        rewardFundingWei: options['reward-funding-wei'] ?? '0' };
      if (input.rewardFundingWei !== '0') throw new Error('formal Pool required before reward funding');
      if (existsSync(`${file}.attempt.json`)) {
        throw new Error('deployment attempt pending; inspect chain before retry');
      }
      if (existsSync(file)) {
        input.existingManifest = JSON.parse(readFileSync(file, 'utf8'));
      } else {
        beginLocalDeployment(file, input);
      }
      const manifest = await deployLocalAssets(input);
      if (!input.existingManifest) completeLocalDeployment(file, manifest);
      console.log(`Local assets deployed and verified: ${file}`);
    }
  }
}
