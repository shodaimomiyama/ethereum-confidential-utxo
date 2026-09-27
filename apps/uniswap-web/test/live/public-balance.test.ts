import { expect, it, vi } from 'vitest';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import type { OperationContext } from '../../src/live/operations.js';
import { createBrowserPublicBalanceReader } from '../../src/live/public-balance.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const scope = { deploymentId: 'local', owner: address('1') } as Scope;
const deployment = { chainId: 31337n, pool: address('2') };
const verified = { context: { chainId: 31337n, pool: deployment.pool, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: deployment.pool } } } as unknown as VerifiedDeployment;

function setup() {
  let epoch = 1;
  let current = deployment;
  const context = { scope: { ...scope }, epoch,
    check: () => { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); } } as OperationContext;
  const getChainId = vi.fn(async () => 31337);
  const getBlock = vi.fn(async (_options: unknown) => ({ number: 12n, hash: hash('a') }));
  const getBalance = vi.fn(async (_options: unknown) => 20n);
  const rpc = { mode: 'local-simulated', policy: { chunkBlocks: 2_000n, minChunkBlocks: 1n,
    retries: 0, requestTimeoutMs: 1_000, overallTimeoutMs: 3_000 },
  client: { getChainId, getBlock, getBalance } } as unknown as RpcConnection;
  return { deps: { context, rpc, verified, resolveDeployment: () => current }, getChainId, getBlock, getBalance,
    setEpoch: (value: number) => { epoch = value; },
    setDeployment: (value: typeof deployment) => { current = value; } };
}

it('returns the connected owner balance with the identified canonical block', async () => {
  const { deps, getBlock, getBalance } = setup();
  const evidence = await createBrowserPublicBalanceReader(deps).read();
  expect(evidence).toEqual({ owner: scope.owner, chainId: 31337n, blockNumber: 12n,
    blockHash: hash('a'), wei: 20n });
  expect(getBalance).toHaveBeenCalledWith({ address: scope.owner, blockNumber: 12n });
  expect(getBlock).toHaveBeenNthCalledWith(1, { blockTag: 'latest' });
  expect(getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 12n });
});

it('refuses reorg and chain drift instead of exposing a balance', async () => {
  const reorg = setup();
  reorg.getBlock.mockResolvedValueOnce({ number: 12n, hash: hash('a') })
    .mockResolvedValueOnce({ number: 12n, hash: hash('b') });
  await expect(createBrowserPublicBalanceReader(reorg.deps).read()).rejects.toThrow('INVALID_PUBLIC_BALANCE');
  const chain = setup();
  chain.getChainId.mockResolvedValueOnce(31337).mockResolvedValueOnce(1);
  await expect(createBrowserPublicBalanceReader(chain.deps).read()).rejects.toThrow('INVALID_PUBLIC_BALANCE');
});

it('refuses scope and pinned deployment drift across asynchronous RPC reads', async () => {
  const epoch = setup();
  epoch.getBalance.mockImplementationOnce(async () => { epoch.setEpoch(2); return 20n; });
  await expect(createBrowserPublicBalanceReader(epoch.deps).read()).rejects.toThrow('SCOPE_CHANGED');
  const deploymentDrift = setup();
  deploymentDrift.getBalance.mockImplementationOnce(async () => {
    deploymentDrift.setDeployment({ ...deployment, pool: address('3') }); return 20n;
  });
  await expect(createBrowserPublicBalanceReader(deploymentDrift.deps).read()).rejects.toThrow('SCOPE_CHANGED');
});

it('refuses malformed evidence and mismatched deployment before use', async () => {
  const malformed = setup();
  malformed.getBalance.mockResolvedValueOnce(-1n);
  await expect(createBrowserPublicBalanceReader(malformed.deps).read()).rejects.toThrow('INVALID_PUBLIC_BALANCE');
  const mismatch = setup();
  expect(() => createBrowserPublicBalanceReader({ ...mismatch.deps,
    rpc: { ...mismatch.deps.rpc, mode: 'finalized' } })).toThrow('INVALID_PUBLIC_BALANCE');
  expect(mismatch.getBalance).not.toHaveBeenCalled();
});
