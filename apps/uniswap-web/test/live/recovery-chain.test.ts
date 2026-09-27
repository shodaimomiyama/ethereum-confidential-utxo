import { expect, it, vi } from 'vitest';
import { commit } from '@confidential-utxo/crypto';
import { operationId, outputId, type Checkpoint, type HistoryPort, type ObservedOperation,
  type Observation, type OperationRequest } from '@confidential-utxo/core';
import { createScopedEthereumBridge } from '../../src/live/ethereum.js';
import { createRecoveryChainReader } from '../../src/live/recovery-chain.js';
import type { OperationContext } from '../../src/live/operations.js';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Scope } from '@confidential-utxo/uniswap';
import { zeroAddress } from 'viem';

vi.mock('../../src/live/ethereum.js', () => ({ createScopedEthereumBridge: vi.fn() }));
const hash = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const owner = `0x${'11'.repeat(20)}` as const;
const pool = `0x${'22'.repeat(20)}` as const;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const context = { chainId: 31337n, pool, deploymentBlock: 1n, verifier: zeroAddress,
  parametersHash: hash('33'), finalityMode: 'local-simulated' as const };
const verified = { context, manifest: { chainId: 31337, pool: { address: pool } } } as unknown as VerifiedDeployment;
const point = { number: 8n, hash: hash('08'), mode: 'local-simulated' as const } satisfies Checkpoint;
const request: OperationRequest = { kind: 0, owner, salt: hash('55'), inputIds: [],
  outputs: [{ owner, commitment: commit({ amount: 2n, blinding: 3n }), receiptFormat: 1,
    packet: `0x${'00'.repeat(112)}` }], d: 2n, w: 0n, destination: zeroAddress };
const id = operationId(context, request);
const outId = outputId(id, 0);
const position = { operationId: id, blockNumber: 3n, blockHash: hash('03'), transactionHash: hash('44'), transactionIndex: 0 };
const operation: ObservedOperation = { request, success: { ...position, logIndex: 1 }, inputLogs: [],
  outputLogs: [{ ...position, output: request.outputs[0]!, outputId: outId, outputIndex: 0, logIndex: 0 }] };
const complete = <T>(value: T): Observation<T> => ({ complete: true, blockHash: point.hash, value });

function fixture() {
  let epoch = 4;
  let deployed = verified;
  const action = { scope, epoch: 4, check: () => { if (epoch !== 4) throw new Error('SCOPE_CHANGED'); } } as OperationContext;
  const history = { getFinalizedCheckpoint: vi.fn(async () => point), getContext: vi.fn(async () => complete(context)),
    getCanonicalHeader: vi.fn(async (number: bigint) => complete({ number, hash: number === point.number ? point.hash : position.blockHash })),
    getOperations: vi.fn(async () => complete([operation])),
    getUtxo: vi.fn(), getOperationSuccess: vi.fn(), getLatestHeader: vi.fn(),
    getLatestUtxo: vi.fn(), getLatestOperationSuccess: vi.fn() } as unknown as HistoryPort;
  vi.mocked(createScopedEthereumBridge).mockReturnValue({ history } as never);
  const reader = createRecoveryChainReader({ context: action, rpc: { mode: 'local-simulated' } as RpcConnection,
    resolveVerified: () => deployed });
  return { reader, action, history, switchScope: () => { epoch++; },
    changeDeployment: () => { deployed = { ...verified, context: { ...context, pool: zeroAddress } }; } };
}

it('reads one finalized checkpoint, complete history, and canonical headers into public output IDs', async () => {
  const f = fixture();
  expect(await f.reader.readFinalized(scope)).toEqual({ outputs: [{ outputId: outId, operationId: id,
    blockHash: position.blockHash }] });
  expect(f.history.getOperations).toHaveBeenCalledWith(context.deploymentBlock, point);
  expect(f.history.getCanonicalHeader).toHaveBeenCalledWith(point.number, point);
  expect(f.history.getCanonicalHeader).toHaveBeenCalledWith(position.blockNumber, point);
});

it.each([
  ['no finality', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getFinalizedCheckpoint).mockResolvedValueOnce(null)],
  ['incomplete operations', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getOperations).mockResolvedValueOnce({ complete: false, reason: 'GAP' })],
  ['wrong range hash', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getOperations).mockResolvedValueOnce({ complete: true, blockHash: hash('ff'), value: [operation] })],
  ['reorged header', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getCanonicalHeader).mockResolvedValueOnce(complete({ number: point.number, hash: hash('ff') }))],
  ['wrong output ID', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getOperations).mockResolvedValueOnce(complete([{ ...operation,
    outputLogs: [{ ...operation.outputLogs[0]!, outputId: hash('ff') }] }]))],
  ['missing success', (f: ReturnType<typeof fixture>) => vi.mocked(f.history.getOperations).mockResolvedValueOnce(complete([{ ...operation, success: undefined }]))],
])('fails closed for %s', async (_name, change) => {
  const f = fixture(); change(f);
  await expect(f.reader.readFinalized(scope)).rejects.toThrow();
});

it('rejects a scope switch or changed verified deployment during a read', async () => {
  const switched = fixture();
  vi.mocked(switched.history.getOperations).mockImplementationOnce(async () => { switched.switchScope(); return complete([operation]); });
  await expect(switched.reader.readFinalized(scope)).rejects.toThrow('SCOPE_CHANGED');
  const changed = fixture();
  vi.mocked(changed.history.getOperations).mockImplementationOnce(async () => { changed.changeDeployment(); return complete([operation]); });
  await expect(changed.reader.readFinalized(scope)).rejects.toThrow('SCOPE_CHANGED');
});
