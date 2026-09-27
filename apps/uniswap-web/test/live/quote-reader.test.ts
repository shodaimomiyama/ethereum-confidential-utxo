import { expect, it, vi } from 'vitest';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import type { OperationContext } from '../../src/live/operations.js';
import type { PreparationDeployment } from '../../src/live/payment-preparation.js';
import { createBrowserQuoteReader } from '../../src/live/quote-reader.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const scope = { deploymentId: 'local', owner: address('1') } as Scope;
const deployment: PreparationDeployment = { chainId: 31337n, pool: address('2'), adapter: address('3'),
  token: address('4'), router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
const verified = { context: { chainId: deployment.chainId, pool: deployment.pool, finalityMode: 'local-simulated' },
  manifest: { chainId: Number(deployment.chainId), pool: { address: deployment.pool } } } as unknown as VerifiedDeployment;

function setup() {
  let epoch = 1;
  let current = deployment;
  const context = { scope, epoch, check: () => { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); } } as OperationContext;
  const getChainId = vi.fn(async () => Number(deployment.chainId));
  const getBlock = vi.fn(async (_options: unknown) => ({ number: 12n, hash: hash('a'), timestamp: 1_000n }));
  const readContract = vi.fn(async (_options: unknown) => [10n, 99n]);
  const rpc = { mode: 'local-simulated', policy: { chunkBlocks: 2_000n, minChunkBlocks: 1n,
    retries: 0, requestTimeoutMs: 1_000, overallTimeoutMs: 3_000 },
  client: { getChainId, getBlock, readContract } } as unknown as RpcConnection;
  const deps = { context, rpc, verified, deployment,
    resolveDeployment: () => current };
  return { deps, getChainId, getBlock, readContract,
    setEpoch: (value: number) => { epoch = value; },
    setDeployment: (value: PreparationDeployment) => { current = value; } };
}

it('reads Router02 quote at the identified block and returns its canonical hash', async () => {
  const { deps, getBlock, readContract, getChainId } = setup();
  const { quoteReader, latestBlockTime } = createBrowserQuoteReader(deps);
  await expect(quoteReader.getAmountsOut(10n, [deployment.weth, deployment.token])).resolves.toEqual({
    blockHash: hash('a'), blockNumber: 12n, amounts: [10n, 99n],
  });
  expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
    address: deployment.router, functionName: 'getAmountsOut', args: [10n, [deployment.weth, deployment.token]],
    blockNumber: 12n,
  }));
  const abi = readContract.mock.calls[0]![0] as { abi: readonly { name?: string; inputs?: readonly { type: string }[] }[] };
  expect(abi.abi).toEqual([expect.objectContaining({ name: 'getAmountsOut',
    inputs: [expect.objectContaining({ type: 'uint256' }), expect.objectContaining({ type: 'address[]' })] })]);
  expect(getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 12n });
  await expect(latestBlockTime()).resolves.toBe(1_000n);
  expect(getChainId).toHaveBeenCalledTimes(4);
});

it('rejects wrong path, malformed amount and malformed quote output', async () => {
  const { deps, readContract } = setup();
  const { quoteReader } = createBrowserQuoteReader(deps);
  await expect(quoteReader.getAmountsOut(0n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');
  await expect(quoteReader.getAmountsOut(10n, [deployment.token, deployment.weth])).rejects.toThrow('INVALID_QUOTE');
  expect(readContract).not.toHaveBeenCalled();
  readContract.mockResolvedValueOnce([11n, 99n]);
  await expect(quoteReader.getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');
  readContract.mockResolvedValueOnce([10n, 0n]);
  await expect(quoteReader.getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');
});

it('rejects changed headers and chain IDs after a pinned read', async () => {
  const changedHeader = setup();
  changedHeader.getBlock.mockResolvedValueOnce({ number: 12n, hash: hash('a'), timestamp: 1_000n });
  changedHeader.getBlock.mockResolvedValueOnce({ number: 12n, hash: hash('b'), timestamp: 1_000n });
  await expect(createBrowserQuoteReader(changedHeader.deps).quoteReader
    .getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');

  const changedNumber = setup();
  changedNumber.getBlock.mockResolvedValueOnce({ number: 12n, hash: hash('a'), timestamp: 1_000n });
  changedNumber.getBlock.mockResolvedValueOnce({ number: 13n, hash: hash('a'), timestamp: 1_000n });
  await expect(createBrowserQuoteReader(changedNumber.deps).quoteReader
    .getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');

  const changedChain = setup();
  changedChain.getChainId.mockResolvedValueOnce(31337).mockResolvedValueOnce(1);
  await expect(createBrowserQuoteReader(changedChain.deps).quoteReader
    .getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('INVALID_QUOTE');
});

it('rejects scope epoch and pinned deployment drift during RPC reads', async () => {
  const changedScope = setup();
  changedScope.readContract.mockImplementationOnce(async () => { changedScope.setEpoch(2); return [10n, 99n]; });
  await expect(createBrowserQuoteReader(changedScope.deps).quoteReader
    .getAmountsOut(10n, [deployment.weth, deployment.token])).rejects.toThrow('SCOPE_CHANGED');

  const changedDeployment = setup();
  changedDeployment.getBlock.mockImplementationOnce(async () => {
    changedDeployment.setDeployment({ ...deployment, router: address('9') });
    return { number: 12n, hash: hash('a'), timestamp: 1_000n };
  });
  await expect(createBrowserQuoteReader(changedDeployment.deps).latestBlockTime()).rejects.toThrow('SCOPE_CHANGED');

  const changedVerified = setup();
  const mutableVerified = structuredClone(verified);
  const reader = createBrowserQuoteReader({ ...changedVerified.deps, verified: mutableVerified });
  mutableVerified.context.verifier = address('9');
  await expect(reader.latestBlockTime()).rejects.toThrow('SCOPE_CHANGED');
});

it('rejects mismatched verified chain and finality mode before RPC use', () => {
  const { deps, getBlock } = setup();
  expect(() => createBrowserQuoteReader({ ...deps,
    deployment: { ...deployment, chainId: 1n } })).toThrow('INVALID_QUOTE');
  expect(() => createBrowserQuoteReader({ ...deps,
    rpc: { ...deps.rpc, mode: 'finalized' } })).toThrow('INVALID_QUOTE');
  expect(getBlock).not.toHaveBeenCalled();
});
