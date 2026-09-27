import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { HistoryPort } from '@confidential-utxo/core';
import { markRewardReceived } from '../src/rewards/store.js';
import type { Scope } from '@confidential-utxo/uniswap';

it('records only the owner output in a finalized canonical operation', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-received'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const owner = `0x${'11'.repeat(20)}`;
    const other = `0x${'22'.repeat(20)}`;
    const id = `0x${'aa'.repeat(32)}`;
    const op = `0x${'bb'.repeat(32)}`;
    const output = `0x${'cc'.repeat(32)}`;
    const block = `0x${'dd'.repeat(32)}`;
    const point = { number: 10n, hash: block as `0x${string}`, mode: 'finalized' as const };
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status, operation_id, checkpoint_hash, output_id)
      VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'finalized', ?, ?, ?)`, owner, id, op, block, output);
    const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
    const history = {
      getFinalizedCheckpoint: async () => point,
      getContext: async () => bound({ deploymentBlock: 1n }),
      getOperations: async () => bound([{ success: { operationId: op, blockNumber: 10n, blockHash: block },
        outputLogs: [{ operationId: op, outputId: output, outputIndex: 0, output: { owner } }] }]),
      getCanonicalHeader: async () => bound({ number: 10n, hash: block }),
      getOperationSuccess: async () => bound({ executed: true }),
    } as unknown as HistoryPort;
    const scope = { deploymentId: 'local-v1', owner } as Scope;
    await expect(markRewardReceived(state.storage, { ...scope, owner: other } as Scope,
      id, output, block, history)).rejects.toThrow('NOT_FOUND');
    await expect(markRewardReceived(state.storage, scope, id, `0x${'ee'.repeat(32)}`,
      block, history)).rejects.toThrow('NOT_FINALIZED');
    await expect(markRewardReceived(state.storage, scope, id, output, block,
      { ...history, getFinalizedCheckpoint: async () => null } as HistoryPort))
      .rejects.toThrow('SERVICE_UNAVAILABLE');
    expect((await markRewardReceived(state.storage, scope, id, output, block, history)).status).toBe('received');
    expect((await markRewardReceived(state.storage, scope, id, output, block, history)).status).toBe('received');
  });
});
