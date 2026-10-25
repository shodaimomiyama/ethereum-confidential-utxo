import { operationId, outputId, validateOperationShape,
  type Checkpoint, type Context, type HistoryPort, type Observation, type ObservedOperation } from '@confidential-utxo/core';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Bytes32, Scope } from '@confidential-utxo/uniswap';
import type { Hex } from 'viem';
import { createScopedEthereumBridge, type ScopedEthereumDependencies } from './ethereum.js';
import { sameScope } from './http.js';
import type { ChainReader, FinalizedHistory } from './recovery.js';

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const hex32 = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const position = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const fingerprint = (value: VerifiedDeployment): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);

function sameContext(left: Context, right: Context): boolean {
  return left.chainId === right.chainId && same(left.pool, right.pool) &&
    left.deploymentBlock === right.deploymentBlock && same(left.verifier, right.verifier) &&
    same(left.parametersHash, right.parametersHash) && left.finalityMode === right.finalityMode;
}

function complete<T>(observation: Observation<T>, point: Checkpoint): T {
  if (!observation.complete || !same(observation.blockHash, point.hash)) throw new Error('INCOMPLETE_CHAIN_HISTORY');
  return observation.value;
}

function samePublicOutput(left: ObservedOperation['request']['outputs'][number],
  right: ObservedOperation['request']['outputs'][number]): boolean {
  return same(left.owner, right.owner) && left.commitment.x === right.commitment.x &&
    left.commitment.y === right.commitment.y && left.receiptFormat === right.receiptFormat &&
    same(left.packet, right.packet);
}

/** Adapts #30's scoped finalized HistoryPort to Recovery's public ID evidence. */
export function createRecoveryChainReader(deps: ScopedEthereumDependencies): ChainReader {
  const { context } = deps;
  const scope = { ...context.scope };
  const epoch = context.epoch;
  const initial = deps.resolveVerified(scope.deploymentId);
  if (!initial) throw new Error('SCOPE_CHANGED');
  const verified = structuredClone(initial);
  const pinned = fingerprint(verified);
  function check(requested: Scope): void {
    context.check();
    const current = deps.resolveVerified(scope.deploymentId);
    if (!sameScope(requested, scope) || !sameScope(context.scope, scope) || context.epoch !== epoch ||
      !current || fingerprint(current) !== pinned || deps.rpc.mode !== verified.context.finalityMode ||
      verified.context.chainId !== BigInt(verified.manifest.chainId) ||
      !same(verified.context.pool, verified.manifest.pool.address)) throw new Error('SCOPE_CHANGED');
  }
  check(scope);
  const history: HistoryPort = createScopedEthereumBridge(deps).history;

  return {
    async readFinalized(requested): Promise<FinalizedHistory> {
      check(requested);
      const finalized = await history.getFinalizedCheckpoint();
      check(requested);
      if (!finalized || finalized.mode !== verified.context.finalityMode ||
        finalized.number < verified.context.deploymentBlock || !hex32(finalized.hash)) throw new Error('NO_FINALITY');
      const point: Checkpoint = finalized;
      const observedContext = complete(await history.getContext(point), point);
      check(requested);
      if (!sameContext(verified.context, observedContext)) throw new Error('CHAIN_CONTEXT_MISMATCH');

      const headers = new Map<bigint, Hex>();
      async function canonical(number: bigint): Promise<Hex> {
        const cached = headers.get(number);
        if (cached) return cached;
        const header = complete(await history.getCanonicalHeader(number, point), point);
        check(requested);
        if (header.number !== number || !hex32(header.hash) ||
          (number === point.number && !same(header.hash, point.hash))) throw new Error('CHAIN_REORG');
        headers.set(number, header.hash);
        return header.hash;
      }
      await canonical(point.number);
      const operations = complete(await history.getOperations(verified.context.deploymentBlock, point), point);
      check(requested);
      const seenOperations = new Set<string>();
      const seenOutputs = new Set<string>();
      const seenLogs = new Set<string>();
      const outputs: FinalizedHistory['outputs'][number][] = [];
      for (const observed of operations) {
        validateOperationShape(observed.request);
        const success = observed.success;
        if (!success || !hex32(success.blockHash) || !hex32(success.transactionHash) ||
          !position(success.transactionIndex) || !position(success.logIndex) ||
          success.blockNumber < verified.context.deploymentBlock || success.blockNumber > point.number) {
          throw new Error('INCOMPLETE_CHAIN_HISTORY');
        }
        const id = operationId(verified.context, observed.request);
        if (!same(id, success.operationId) || seenOperations.has(id.toLowerCase())) throw new Error('CHAIN_ID_MISMATCH');
        seenOperations.add(id.toLowerCase());
        if (!same(await canonical(success.blockNumber), success.blockHash)) throw new Error('CHAIN_REORG');
        const inputs = observed.inputLogs ?? [];
        if (inputs.length !== observed.request.inputIds.length ||
          observed.outputLogs.length !== observed.request.outputs.length ||
          success.logIndex < inputs.length + observed.outputLogs.length) throw new Error('INCOMPLETE_CHAIN_HISTORY');
        const firstLog = success.logIndex - inputs.length - observed.outputLogs.length;
        const logs = [...inputs, ...observed.outputLogs, success];
        for (let index = 0; index < logs.length; index++) {
          const log = logs[index]!;
          const logKey = `${log.blockNumber}:${log.logIndex}`;
          if (!position(log.logIndex) || log.logIndex !== firstLog + index ||
            log.blockNumber !== success.blockNumber || !same(log.blockHash, success.blockHash) ||
            !same(log.transactionHash, success.transactionHash) || log.transactionIndex !== success.transactionIndex ||
            !same(log.operationId, id) || seenLogs.has(logKey)) throw new Error('CHAIN_LOG_MISMATCH');
          seenLogs.add(logKey);
        }
        for (let index = 0; index < inputs.length; index++) {
          if (!same(inputs[index]!.inputId, observed.request.inputIds[index]!)) throw new Error('CHAIN_LOG_MISMATCH');
        }
        for (let index = 0; index < observed.outputLogs.length; index++) {
          const log = observed.outputLogs[index]!;
          const expected = outputId(id, index);
          if (log.outputIndex !== index || !same(log.outputId, expected) ||
            !samePublicOutput(log.output, observed.request.outputs[index]!) || seenOutputs.has(expected.toLowerCase())) {
            throw new Error('CHAIN_ID_MISMATCH');
          }
          seenOutputs.add(expected.toLowerCase());
          outputs.push({ outputId: expected as Bytes32, operationId: id as Bytes32,
            blockHash: success.blockHash as Bytes32 });
        }
      }
      const after = complete(await history.getCanonicalHeader(point.number, point), point);
      check(requested);
      if (after.number !== point.number || !same(after.hash, point.hash)) throw new Error('CHAIN_REORG');
      return { outputs };
    },
  };
}
