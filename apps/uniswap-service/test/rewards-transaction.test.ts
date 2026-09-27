import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { broadcastRewardAttempt, listRewardAttempts, saveRewardAttempt } from '../src/rewards/transaction.js';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getReward } from '../src/rewards/store.js';

it('stores signed raw before broadcast and reuses the same attempt after a lost response', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-transaction-storage'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const id = `0x${'aa'.repeat(32)}`;
    const op = `0x${'bb'.repeat(32)}`;
    const key = new Uint8Array(32).fill(8);
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status, operation_id)
      VALUES ('local-v1', ?, ?, '2', '{}', 'hash', 'processing', ?)`, `0x${'11'.repeat(20)}`, id, op);
    state.storage.sql.exec(`INSERT INTO reward_drafts (deployment_id, request_id, phase, version, encrypted_json)
      VALUES ('local-v1', ?, 'signature-started', 1, 'ciphertext')`, id);
    const rpc = { sendRawTransaction: vi.fn(async () => { throw new Error('response lost'); }) };
    const signer = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const sign = (maxFeePerGas: bigint) => signer.signTransaction({ type: 'eip1559', chainId: 31337,
      to: `0x${'99'.repeat(20)}`, data: '0x1234', value: 0n, gas: 100000n, nonce: 7,
      maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas === 100n ? 2n : 3n });
    const raw = await sign(100n);
    const attempt = { raw, hash: keccak256(raw),
      nonce: 7, operationId: op };
    await expect(saveRewardAttempt(state.storage, 'local-v1', id, key, attempt,
      () => { throw new Error('storage rejected'); })).rejects.toThrow();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(await saveRewardAttempt(state.storage, 'local-v1', id, key, attempt)).toBe(1);
    state.storage.sql.exec(`INSERT INTO reward_inputs (deployment_id, input_id, request_id, status)
      VALUES ('local-v1', ?, ?, 'unknown')`, `0x${'dd'.repeat(32)}`, id);
    await expect(broadcastRewardAttempt(state.storage, 'local-v1', id, 1, key, rpc)).rejects.toThrow();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    state.storage.sql.exec(`UPDATE reward_inputs SET status = 'reserved' WHERE request_id = ?`, id);
    state.storage.sql.exec(`INSERT INTO reward_availability (deployment_id, reason, checked_at_ms)
      VALUES ('local-v1', 'operator-stopped', 1)`);
    await expect(broadcastRewardAttempt(state.storage, 'local-v1', id, 1, key, rpc)).rejects.toThrow();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    state.storage.sql.exec(`UPDATE reward_availability SET reason = 'healthy' WHERE deployment_id = 'local-v1'`);
    await broadcastRewardAttempt(state.storage, 'local-v1', id, 1, key, rpc);
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: attempt.raw });
    expect(await listRewardAttempts(state.storage, 'local-v1', id, key)).toMatchObject([
      { ...attempt, attemptNo: 1, outerStatus: 'unknown' },
    ]);
    const replacementRaw = await sign(120n);
    const replacement = { ...attempt, raw: replacementRaw, hash: keccak256(replacementRaw) };
    expect(await saveRewardAttempt(state.storage, 'local-v1', id, key, replacement)).toBe(2);
    expect((await listRewardAttempts(state.storage, 'local-v1', id, key)).map((item) =>
      [item.operationId, item.nonce, item.hash])).toEqual([
      [op, 7, attempt.hash], [op, 7, replacement.hash],
    ]);
    expect(getReward(state.storage, { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as
      import('@confidential-utxo/uniswap').Scope, id)?.txHashes).toEqual([attempt.hash, replacement.hash]);
  });
});
