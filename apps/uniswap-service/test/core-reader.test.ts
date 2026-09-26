import type { Checkpoint, Context, HistoryPort } from '@confidential-utxo/core';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';
import { expect, it } from 'vitest';
import { createCoreInputReader } from '../src/core-reader.js';
import type { DeploymentConfig } from '../src/config.js';

const hash = `0x${'11'.repeat(32)}` as const;
const owner = `0x${'aa'.repeat(20)}` as const;
const pool = `0x${'bb'.repeat(20)}` as const;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const inputId = `0x${'cc'.repeat(32)}` as OperationRecord['inputId'];
const point: Checkpoint = { number: 10n, hash, mode: 'finalized' };
const context: Context = {
  chainId: 31337n, pool, deploymentBlock: 1n, verifier: pool,
  parametersHash: hash, finalityMode: 'finalized',
};
const config: DeploymentConfig = { origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337, pool, finalityMode: 'finalized' };

function history(overrides: {
  owner?: string; consumedBy?: string; complete?: boolean; context?: Context; latestContext?: Context;
  latestConsumedBy?: string; ancestorHash?: string;
} = {}): HistoryPort {
  const observed = <T>(value: T) => overrides.complete === false
    ? { complete: false as const, reason: 'GAP' as const }
    : { complete: true as const, blockHash: hash, value };
  let contextReads = 0;
  return {
    getFinalizedCheckpoint: async () => point,
    getContext: async () => observed(contextReads++ === 0 ? overrides.context ?? context : overrides.latestContext ?? context),
    getUtxo: async () => observed({ exists: true, owner: overrides.owner ?? owner,
      commitment: { x: 1n, y: 2n },
      ...(overrides.consumedBy ? { consumedBy: overrides.consumedBy } : {}) }),
    getLatestHeader: async () => ({ number: 10n, hash }),
    getLatestUtxo: async () => observed({ exists: true, owner, commitment: { x: 1n, y: 2n },
      ...(overrides.latestConsumedBy ? { consumedBy: overrides.latestConsumedBy } : {}) }),
    getCanonicalHeader: async () => observed({ number: 10n, hash: overrides.ancestorHash ?? hash }),
  } as unknown as HistoryPort;
}

it('uses #29 finalized and latest observations to identify an owned unspent input', async () => {
  const reader = createCoreInputReader(history(), config);
  expect(await reader.readInput(scope, inputId)).toBe('owned-unspent');
  expect(await createCoreInputReader(history({ owner: `0x${'dd'.repeat(20)}` }), config)
    .readInput(scope, inputId)).toBe('other-owner');
  expect(await createCoreInputReader(history({ latestConsumedBy: hash }), config)
    .readInput(scope, inputId)).toBe('spent');
  expect(await createCoreInputReader(history({ complete: false }), config)
    .readInput(scope, inputId)).toBe('unknown');
  expect(await createCoreInputReader(history({ ancestorHash: `0x${'ee'.repeat(32)}` }), config)
    .readInput(scope, inputId)).toBe('unknown');
  expect(await createCoreInputReader(history({ context: { ...context, chainId: 1n } }), config)
    .readInput(scope, inputId)).toBe('unknown');
  expect(await createCoreInputReader(history({ latestContext: { ...context, parametersHash: `0x${'ff'.repeat(32)}` } }), config)
    .readInput(scope, inputId)).toBe('unknown');
});

it('uses the deployment finality mode and rejects a mismatched checkpoint', async () => {
  const localConfig = { ...config, finalityMode: 'local-simulated' as const };
  const localHistory = history();
  localHistory.getFinalizedCheckpoint = async () => ({ ...point, mode: 'local-simulated' });
  localHistory.getContext = async () => ({ complete: true, blockHash: hash,
    value: { ...context, finalityMode: 'local-simulated' } });
  expect(await createCoreInputReader(localHistory, localConfig).readInput(scope, inputId)).toBe('owned-unspent');
  expect(await createCoreInputReader(history(), localConfig).readInput(scope, inputId)).toBe('unknown');
});
