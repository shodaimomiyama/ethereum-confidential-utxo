import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { buildAndAuthorizeReward, claimRewardWork, loadSavedDraft, markSignatureStarted, saveDraftIfCurrent } from '../src/rewards/store.js';

it('claims one draft generation and restores its encrypted identity', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-draft-claim'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'aa'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status) VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'accepted')`,
    `0x${'11'.repeat(20)}`, id);
    const claimed = claimRewardWork(state.storage, 'local-v1', id);
    expect(claimed).toEqual({ revision: 1, phase: 'claimed' });
    expect(state.storage.sql.exec<{ status: string }>(
      'SELECT status FROM reward_requests WHERE request_id = ?', id).toArray()[0]?.status).toBe('processing');
    expect(claimRewardWork(state.storage, 'local-v1', id)).toBeUndefined();
    const key = new Uint8Array(32).fill(4);
    const draft = { operationId: `0x${'bb'.repeat(32)}`, request: {
      inputIds: [`0x${'ee'.repeat(32)}`], outputs: [{ packet: `0x${'cc'.repeat(112)}` }],
    } };
    expect(await saveDraftIfCurrent(state.storage, 'local-v1', id, 1, key, draft)).toBe(true);
    expect(state.storage.sql.exec<{ input_id: string }>(
      'SELECT input_id FROM reward_inputs WHERE request_id = ?', id).toArray())
      .toEqual([{ input_id: `0x${'ee'.repeat(32)}` }]);
    expect((await loadSavedDraft<typeof draft>(state.storage, 'local-v1', id, key))?.operationId).toBe(draft.operationId);
    expect((await loadSavedDraft<typeof draft>(state.storage, 'local-v1', id, key))?.request.outputs[0]?.packet)
      .toBe(draft.request.outputs[0]?.packet);
    expect(claimRewardWork(state.storage, 'local-v1', id)).toBeUndefined();
    expect(markSignatureStarted(state.storage, 'local-v1', id, 1)).toBe(true);
    expect(markSignatureStarted(state.storage, 'local-v1', id, 1)).toBe(false);
  });
});

it('does not regenerate an interrupted random draft', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-draft-interrupt'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'dd'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status) VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'accepted')`,
    `0x${'11'.repeat(20)}`, id);
    const build = () => buildAndAuthorizeReward(state.storage, 'local-v1', id, new Uint8Array(32).fill(1),
      { kind: 0, owner: `0x${'11'.repeat(20)}`, amount: 0n,
        recipient: {} as import('@confidential-utxo/core').RecipientInfo },
      { chainId: 31337n, pool: `0x${'11'.repeat(20)}`, deploymentBlock: 1n,
        verifier: `0x${'11'.repeat(20)}`, parametersHash: `0x${'00'.repeat(32)}`, finalityMode: 'finalized' },
      [], { signTypedData: async () => `0x${'00'.repeat(65)}` });
    await expect(build()).rejects.toThrow();
    expect(await build()).toBeUndefined();
    expect(state.storage.sql.exec<{ phase: string }>('SELECT phase FROM reward_drafts WHERE request_id = ?', id).toArray())
      .toEqual([{ phase: 'claimed' }]);
  });
});

it('reacquires an input released by a safely ended unsigned request', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-draft-reacquire'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const first = `0x${'aa'.repeat(32)}`;
    const second = `0x${'bb'.repeat(32)}`;
    const input = `0x${'cc'.repeat(32)}`;
    for (const id of [first, second]) state.storage.sql.exec(`INSERT INTO reward_requests
      (deployment_id, owner, request_id, amount_wei, recipient_info_json, content_hash, status)
      VALUES ('local-v1', ?, ?, '2', '{}', ?, 'accepted')`, `0x${id.slice(2, 42)}`, id, id);
    const draft = (operationId: string) => ({ operationId, request: { inputIds: [input] } });
    expect(claimRewardWork(state.storage, 'local-v1', first)).toBeDefined();
    expect(await saveDraftIfCurrent(state.storage, 'local-v1', first, 1,
      new Uint8Array(32).fill(1), draft(first))).toBe(true);
    state.storage.sql.exec("UPDATE reward_requests SET status = 'ended-without-distribution' WHERE request_id = ?", first);
    state.storage.sql.exec("UPDATE reward_inputs SET status = 'released' WHERE request_id = ?", first);
    expect(claimRewardWork(state.storage, 'local-v1', second)).toBeDefined();
    expect(await saveDraftIfCurrent(state.storage, 'local-v1', second, 1,
      new Uint8Array(32).fill(1), draft(second))).toBe(true);
  });
});
