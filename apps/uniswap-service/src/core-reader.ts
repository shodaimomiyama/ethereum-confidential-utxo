import type { Checkpoint, Context, HistoryPort, Observation, UtxoState } from '@confidential-utxo/core';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';
import type { Hex } from 'viem';
import type { DeploymentConfig } from './config.js';
import type { InputReader, InputState } from './store.js';

export type CoreHistoryProvider = (deploymentId: string, config: DeploymentConfig) => HistoryPort;
let historyProvider: CoreHistoryProvider | undefined;

/** Registered at module startup by the trusted #30 adapter, never by an HTTP request. */
export function registerCoreHistoryProvider(provider: CoreHistoryProvider): void {
  if (historyProvider !== undefined) throw new Error('CORE_HISTORY_ALREADY_REGISTERED');
  historyProvider = provider;
}

export function getCoreHistoryProvider(): CoreHistoryProvider | undefined { return historyProvider; }

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function read<T>(observation: Observation<T>, point: Checkpoint): T | undefined {
  return observation.complete && same(observation.blockHash, point.hash) ? observation.value : undefined;
}

function matchesContext(context: Context, config: DeploymentConfig): boolean {
  return context.chainId === BigInt(config.chainId) && same(context.pool, config.pool)
    && context.finalityMode === 'finalized' && context.deploymentBlock >= 0n;
}

function sameContext(left: Context, right: Context): boolean {
  return left.chainId === right.chainId && same(left.pool, right.pool)
    && left.deploymentBlock === right.deploymentBlock && same(left.verifier, right.verifier)
    && same(left.parametersHash, right.parametersHash) && left.finalityMode === right.finalityMode;
}

function classify(state: UtxoState, scope: Scope): InputState {
  if (!state.exists) return 'other-owner';
  if (state.owner === undefined || !same(state.owner, scope.owner)) return 'other-owner';
  if (state.consumedBy !== undefined) return 'spent';
  return state.commitment === undefined ? 'unknown' : 'owned-unspent';
}

/** Adapts #29's pinned public history boundary without reading private openings. */
export function createCoreInputReader(history: HistoryPort, config: DeploymentConfig): InputReader {
  return {
    async readInput(scope: Scope, inputId: OperationRecord['inputId']): Promise<InputState> {
      try {
        const finalized = await history.getFinalizedCheckpoint();
        if (finalized === null || finalized.mode !== 'finalized') return 'unknown';
        const context = read(await history.getContext(finalized), finalized);
        if (context === undefined || !matchesContext(context, config)
          || finalized.number < context.deploymentBlock) return 'unknown';
        const latest = await history.getLatestHeader();
        if (latest === null || latest.number < finalized.number) return 'unknown';
        const latestPoint: Checkpoint = { ...latest, mode: 'finalized' };
        const ancestor = read(await history.getCanonicalHeader(finalized.number, latestPoint), latestPoint);
        if (ancestor === undefined || ancestor.number !== finalized.number
          || !same(ancestor.hash, finalized.hash)) return 'unknown';
        const atFinalized = read(await history.getUtxo(inputId as Hex, finalized), finalized);
        if (atFinalized === undefined) return 'unknown';
        const finalState = classify(atFinalized, scope);
        if (finalState !== 'owned-unspent') return finalState;
        const latestContext = read(await history.getContext(latestPoint), latestPoint);
        if (latestContext === undefined || !matchesContext(latestContext, config)
          || !sameContext(context, latestContext)) return 'unknown';
        const atLatest = read(await history.getLatestUtxo(inputId as Hex, latest), latestPoint);
        if (atLatest === undefined) return 'unknown';
        const latestState = classify(atLatest, scope);
        const current = read(await history.getCanonicalHeader(latest.number, latestPoint), latestPoint);
        if (current === undefined || current.number !== latest.number || !same(current.hash, latest.hash)) return 'unknown';
        return latestState;
      } catch { return 'unknown'; }
    },
  };
}
