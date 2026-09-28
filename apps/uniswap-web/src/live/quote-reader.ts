import { readWithPolicy, type RpcConnection, type VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Bytes32, QuoteReader } from '@confidential-utxo/uniswap';
import { isAddress } from 'viem';
import uniswapV2 from '../../../../packages/ethereum/generated/uniswap-v2.json' with { type: 'json' };
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import type { PreparationDeployment } from './payment-preparation.js';

export interface BrowserQuoteDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly verified: VerifiedDeployment;
  readonly deployment: PreparationDeployment;
  /** Return only a previously verified and pinned Uniswap deployment. */
  readonly resolveDeployment: (id: OperationContext['scope']['deploymentId']) => PreparationDeployment | undefined;
}

const routerAbi = uniswapV2.artifacts.router02.abi.filter(item => item.type === 'function' && item.name === 'getAmountsOut');
const uint256Max = (1n << 256n) - 1n;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const validAddress = (value: unknown): value is Address => typeof value === 'string'
  && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const validHash = (value: unknown): value is Bytes32 => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const fingerprint = (value: VerifiedDeployment): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
function invalid(): never { throw new Error('INVALID_QUOTE'); }
function drifted(): never { throw new Error('SCOPE_CHANGED'); }

/** Reads a quote at one identified block. It supplies no finality or execution evidence. */
export function createBrowserQuoteReader(deps: BrowserQuoteDependencies): {
  readonly quoteReader: QuoteReader;
  readonly latestBlockTime: () => Promise<bigint>;
} {
  const { context, rpc, verified } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const pinned = { ...deps.deployment };
  const verifiedFingerprint = fingerprint(verified);
  if (routerAbi.length !== 1 || !scope.deploymentId || !validAddress(scope.owner)
    || pinned.chainId <= 0n || pinned.chainId !== verified.context.chainId
    || pinned.chainId !== BigInt(verified.manifest.chainId)
    || !validAddress(pinned.pool) || !same(pinned.pool, verified.context.pool)
    || !same(pinned.pool, verified.manifest.pool.address)
    || !validAddress(pinned.adapter) || !validAddress(pinned.router)
    || !validAddress(pinned.factory) || !validAddress(pinned.weth)
    || !validAddress(pinned.token) || !validAddress(pinned.pair)
    || same(pinned.weth, pinned.token) || rpc.mode !== verified.context.finalityMode) invalid();

  function check(): void {
    context.check();
    const current = deps.resolveDeployment(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current
      || current.chainId !== pinned.chainId || !same(current.pool, pinned.pool)
      || !same(current.adapter, pinned.adapter) || !same(current.router, pinned.router)
      || !same(current.factory, pinned.factory) || !same(current.weth, pinned.weth)
      || !same(current.token, pinned.token) || !same(current.pair, pinned.pair)
      || fingerprint(verified) !== verifiedFingerprint
      || verified.context.chainId !== pinned.chainId
      || !same(verified.context.pool, pinned.pool)
      || BigInt(verified.manifest.chainId) !== pinned.chainId
      || !same(verified.manifest.pool.address, pinned.pool)) drifted();
  }
  check();

  async function read<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    check();
    const remaining = deadline - Date.now();
    if (remaining <= 0) invalid();
    const result = await readWithPolicy(() => operation(), {
      ...rpc.policy, overallTimeoutMs: Math.min(rpc.policy.overallTimeoutMs, remaining),
    });
    check();
    return result;
  }
  async function chain(deadline: number): Promise<void> {
    if (BigInt(await read(() => rpc.client.getChainId(), deadline)) !== pinned.chainId) invalid();
  }
  async function block(deadline: number, number?: bigint) {
    const header = await read(() => number === undefined
      ? rpc.client.getBlock({ blockTag: 'latest' })
      : rpc.client.getBlock({ blockNumber: number }), deadline);
    if (typeof header.number !== 'bigint' || header.number < 0n || !validHash(header.hash)
      || typeof header.timestamp !== 'bigint' || header.timestamp < 0n
      || (number !== undefined && header.number !== number)) invalid();
    return { number: header.number, hash: header.hash, timestamp: header.timestamp };
  }
  async function stableBlock(deadline: number) {
    await chain(deadline);
    const first = await block(deadline);
    return { first, async confirm() {
      const second = await block(deadline, first.number);
      await chain(deadline);
      if (!same(first.hash, second.hash) || first.timestamp !== second.timestamp) invalid();
    } };
  }

  const quoteReader: QuoteReader = {
    async getAmountsOut(inputWei, path) {
      check();
      if (typeof inputWei !== 'bigint' || inputWei <= 0n || inputWei > uint256Max
        || !Array.isArray(path) || path.length !== 2
        || !validAddress(path[0]) || !validAddress(path[1])
        || !same(path[0], pinned.weth) || !same(path[1], pinned.token)) invalid();
      const deadline = Date.now() + rpc.policy.overallTimeoutMs;
      const selected = await stableBlock(deadline);
      const amounts = await read(() => rpc.client.readContract({
        address: pinned.router, abi: routerAbi, functionName: 'getAmountsOut',
        args: [inputWei, [pinned.weth, pinned.token]], blockNumber: selected.first.number,
      }), deadline);
      await selected.confirm();
      if (!Array.isArray(amounts) || amounts.length !== 2
        || typeof amounts[0] !== 'bigint' || amounts[0] !== inputWei
        || typeof amounts[1] !== 'bigint' || amounts[1] <= 0n || amounts[1] > uint256Max) invalid();
      return { blockHash: selected.first.hash, blockNumber: selected.first.number, amounts };
    },
  };
  return {
    quoteReader,
    async latestBlockTime() {
      check();
      const deadline = Date.now() + rpc.policy.overallTimeoutMs;
      const selected = await stableBlock(deadline);
      await selected.confirm();
      return selected.first.timestamp;
    },
  };
}
