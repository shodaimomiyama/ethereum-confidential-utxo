import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { advanceRewardConsolidation } from '../src/rewards/consolidation.js';
import { buildConsolidationDraft } from '../src/rewards/consolidation.js';
import { commit } from '@confidential-utxo/crypto';
import { selectInputs } from '@confidential-utxo/core';
import type { Context, OwnedUtxo } from '@confidential-utxo/core';
import { privateKeyToAccount } from 'viem/accounts';

it('stores a self-transfer draft and signed raw before broadcast and waits for finalized consolidation', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-consolidation'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'aa'.repeat(32)}`;
    const operationId = `0x${'bb'.repeat(32)}`;
    const raw = '0x1234' as `0x${string}`;
    const key = new Uint8Array(32).fill(8);
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
      amount_wei, recipient_info_json, content_hash, status)
      VALUES ('local-v1', ?, ?, '10', '{}', 'hash', 'accepted')`, `0x${'11'.repeat(20)}`, id);
    let finalized = false;
    let broadcasts = 0;
    const ports = {
      build: async () => ({ operationId, inputIds: [`0x${'cc'.repeat(32)}`, `0x${'dd'.repeat(32)}`],
        draft: { operationId } }),
      sign: async (draft: { operationId: string }) => ({ ...draft, signature: '0xsigned' }),
      prepare: async () => ({ raw, hash: keccak256(raw), nonce: 1 }),
      observe: async () => finalized
        ? { kind: 'finalized' as const, checkpointHash: `0x${'ee'.repeat(32)}` }
        : 'none' as const,
      broadcast: async (sent: string) => {
        const row = state.storage.sql.exec<{ encrypted_raw: string }>(
          'SELECT encrypted_raw FROM reward_consolidations WHERE request_id = ?', id).toArray()[0];
        expect(row?.encrypted_raw).toBeDefined();
        expect(row?.encrypted_raw).not.toBe(raw);
        expect(sent).toBe(raw);
        broadcasts++;
      },
    };
    expect(await advanceRewardConsolidation(state.storage, 'local-v1', id, key, ports)).toBe(false);
    expect(broadcasts).toBe(1);
    finalized = true;
    expect(await advanceRewardConsolidation(state.storage, 'local-v1', id, key, ports)).toBe(true);
    expect(state.storage.sql.exec<{ phase: string; checkpoint_hash: string }>(
      'SELECT phase, checkpoint_hash FROM reward_consolidations WHERE request_id = ?', id).toArray())
      .toEqual([{ phase: 'finalized', checkpoint_hash: `0x${'ee'.repeat(32)}` }]);
  });
});

it('uses a real self-transfer to make a three-input reward constructable', async () => {
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const context: Context = { chainId: 31337n, pool: `0x${'11'.repeat(20)}`,
    verifier: `0x${'22'.repeat(20)}`, parametersHash: `0x${'00'.repeat(32)}`,
    deploymentBlock: 1n, finalityMode: 'local-simulated' };
  const coins: OwnedUtxo[] = [1, 2, 3].map((index) => {
    const opening = { amount: 4n, blinding: BigInt(index) };
    return { id: `0x${String(index).repeat(64)}` as `0x${string}`,
      owner: account.address, opening, commitment: commit(opening),
      checkpoint: { number: 1n, hash: `0x${'aa'.repeat(32)}`, mode: 'local-simulated' },
      status: 'available', chainId: context.chainId, pool: context.pool };
  });
  expect(() => selectInputs(context, coins, { kind: 1, owner: account.address, amount: 10n }))
    .toThrow();
  const built = await buildConsolidationDraft(context, account, new Uint8Array(32).fill(7), coins);
  expect(built.inputIds).toHaveLength(2);
  expect(built.draft.operationId).toBe(built.operationId);
  expect(built.draft.request.outputs).toHaveLength(1);
  expect(built.draft.request.outputs[0]?.owner).toBe(account.address);
});
