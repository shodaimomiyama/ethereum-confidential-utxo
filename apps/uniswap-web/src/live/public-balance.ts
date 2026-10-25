import { readWithPolicy, type RpcConnection, type VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import { isAddress } from 'viem';
import { sameScope } from './http.js';
import type { OperationContext } from './operations.js';
import type { DeploymentLocation } from './scope.js';

export interface PublicBalanceDependencies {
  readonly context: OperationContext;
  readonly rpc: RpcConnection;
  readonly verified: VerifiedDeployment;
  readonly resolveDeployment: (id: Scope['deploymentId']) => DeploymentLocation | undefined;
}

/** A public account observation at one block; it does not establish gas sufficiency or finality. */
export interface PublicEthBalanceEvidence {
  readonly owner: Address;
  readonly chainId: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly wei: bigint;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const validAddress = (value: unknown): value is Address => typeof value === 'string'
  && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const validHash = (value: unknown): value is `0x${string}` => typeof value === 'string'
  && /^0x[0-9a-fA-F]{64}$/.test(value);
const fingerprint = (value: VerifiedDeployment): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
function invalid(): never { throw new Error('INVALID_PUBLIC_BALANCE'); }
function drifted(): never { throw new Error('SCOPE_CHANGED'); }

/** Reads the owner's ETH balance at a numbered latest block, then checks its canonical header again. */
export function createBrowserPublicBalanceReader(deps: PublicBalanceDependencies): {
  readonly read: () => Promise<PublicEthBalanceEvidence>;
} {
  const { context, rpc, verified } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const chainId = verified.context.chainId;
  const pool = verified.context.pool;
  const verifiedFingerprint = fingerprint(verified);
  if (!scope.deploymentId || !validAddress(scope.owner) || !validAddress(pool)
    || chainId <= 0n || chainId !== BigInt(verified.manifest.chainId)
    || !same(pool, verified.manifest.pool.address)
    || rpc.mode !== verified.context.finalityMode) invalid();

  function check(): void {
    context.check();
    const current = deps.resolveDeployment(scope.deploymentId);
    if (!sameScope(context.scope, scope) || context.epoch !== epoch || !current
      || current.chainId !== chainId || !same(current.pool, pool)
      || fingerprint(verified) !== verifiedFingerprint) drifted();
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

  return { async read() {
    check();
    const deadline = Date.now() + rpc.policy.overallTimeoutMs;
    if (BigInt(await read(() => rpc.client.getChainId(), deadline)) !== chainId) invalid();
    const first = await read(() => rpc.client.getBlock({ blockTag: 'latest' }), deadline);
    if (typeof first.number !== 'bigint' || first.number < 0n || !validHash(first.hash)) invalid();
    const wei = await read(() => rpc.client.getBalance({ address: scope.owner, blockNumber: first.number }), deadline);
    const second = await read(() => rpc.client.getBlock({ blockNumber: first.number }), deadline);
    if (typeof second.number !== 'bigint' || second.number !== first.number || !validHash(second.hash)
      || !same(first.hash, second.hash) || typeof wei !== 'bigint' || wei < 0n
      || wei > (1n << 256n) - 1n) invalid();
    if (BigInt(await read(() => rpc.client.getChainId(), deadline)) !== chainId) invalid();
    check();
    return { owner: scope.owner, chainId, blockNumber: first.number, blockHash: first.hash, wei };
  } };
}
