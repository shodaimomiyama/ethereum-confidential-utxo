import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { rewardExtension } from '../src/rewards/extension.js';
import { makeServiceContext } from '../src/extensions.js';
import { recipientInfoTypedData } from '@confidential-utxo/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { admitReward } from '../src/rewards/store.js';

it('lists only the authenticated owner rewards from the shared SQLite DO', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-admission-list'));
  await stub.fetch('https://site.test/v1/operations');
  const owner = `0x${'11'.repeat(20)}`;
  const other = `0x${'22'.repeat(20)}`;
  const scope = { deploymentId: 'local-v1', owner };
  const request = parseApiRequest('GET', `/v1/rewards?deploymentId=local-v1&owner=${owner}`, undefined);
  const route = rewardExtension.routes.find((entry) => entry.route === 'GET /v1/rewards');
  expect(route).toBeDefined();
  await runInDurableObject(stub, async (_object, state) => {
    const sql = state.storage.sql;
    for (const [subject, id] of [[owner, `0x${'aa'.repeat(32)}`], [other, `0x${'bb'.repeat(32)}`]] as const) {
      sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
        recipient_info_json, content_hash, status) VALUES (?, ?, ?, '1', ?, ?, 'accepted')`,
      'local-v1', subject, id, JSON.stringify({ owner: subject, publicKey: `0x${'33'.repeat(32)}`, signature: `0x${'44'.repeat(65)}` }), id);
    }
    const response = await route!.handle(request, makeServiceContext(state.storage,
      { generation: 'test-g1', stopped: false }, request.scope));
    expect(response.status).toBe(200);
    const body = await response.json() as { rewards: { requestId: string }[] };
    expect(body.rewards.map((reward) => reward.requestId)).toEqual([`0x${'aa'.repeat(32)}`]);
    const single = rewardExtension.routes.find((entry) => entry.route === 'GET /v1/rewards/{id}');
    expect(single).toBeDefined();
    const hiddenRequest = parseApiRequest('GET', `/v1/rewards/0x${'bb'.repeat(32)}?deploymentId=local-v1&owner=${owner}`, undefined);
    const hidden = await single!.handle(hiddenRequest,
      makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }, request.scope));
    expect(hidden.status).toBe(404);
    const otherRequest = parseApiRequest('GET',
      `/v1/rewards?deploymentId=local-v1&owner=${other}`, undefined);
    const forbidden = await route!.handle(otherRequest, makeServiceContext(state.storage,
      { generation: 'test-g1', stopped: false }, request.scope));
    expect(forbidden.status).toBe(403);
  });
});

it('serializes reservations across owners and preserves the pending owner request', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-admission-capacity'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const make = (owner: string, suffix: string, amountWei: bigint) => parseApiRequest('POST', '/v1/rewards', {
      scope: { deploymentId: 'local-v1', owner }, requestId: `0x${suffix.repeat(64)}`,
      amountWei: amountWei.toString(),
      recipientInfo: { owner, publicKey: `0x${'33'.repeat(32)}`,
        signature: `0x${'44'.repeat(65)}` },
    }).reward!;
    const a = make(`0x${'11'.repeat(20)}`, 'a', 6n);
    const b = make(`0x${'22'.repeat(20)}`, 'b', 4n);
    const c = make(`0x${'33'.repeat(20)}`, 'c', 1n);
    expect(admitReward(state.storage, a, 10n).kind).toBe('accepted');
    expect(admitReward(state.storage, b, 10n).kind).toBe('accepted');
    expect(admitReward(state.storage, c, 10n).kind).toBe('insufficient');
    expect(admitReward(state.storage, make(a.scope.owner, 'd', 1n), 10n)).toMatchObject({
      kind: 'pending', record: { requestId: a.requestId },
    });
    expect(() => admitReward(state.storage, { ...a, amountWei: 5n }, 10n)).toThrow('REQUEST_CONFLICT');
    expect(state.storage.sql.exec<{ amount_wei: string }>(
      'SELECT amount_wei FROM reward_reservations ORDER BY amount_wei').toArray())
      .toEqual([{ amount_wei: '4' }, { amount_wei: '6' }]);
  });
});

it('reserves a submitted reward once and returns the same request after an ACK retry', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-admission-post'));
  await stub.fetch('https://site.test/v1/operations');
  const account = privateKeyToAccount(generatePrivateKey());
  const pool = '0x0000000000000000000000000000000000000001';
  const key = `0x${'33'.repeat(32)}` as `0x${string}`;
  const unsigned = {
    chainId: 31337n, pool: pool as `0x${string}`, owner: account.address,
    receivePublicKey: key, receiptFormat: 1 as const, recipientInfoVersion: 1 as const,
  };
  const signature = await account.signTypedData(recipientInfoTypedData(
    { chainId: 31337n, pool: pool as `0x${string}` }, unsigned, account.address));
  const scope = { deploymentId: 'local-v1', owner: account.address };
  const id = `0x${'aa'.repeat(32)}`;
  const request = parseApiRequest('POST', '/v1/rewards', {
    scope, requestId: id, amountWei: '4',
    recipientInfo: { owner: account.address, publicKey: key, signature },
  });
  const route = rewardExtension.routes.find((entry) => entry.route === 'POST /v1/rewards');
  expect(route).toBeDefined();
  await runInDurableObject(stub, async (_object, state) => {
    const context = {
      ...makeServiceContext(state.storage, { generation: 'test-g1', stopped: false }, request.scope, {
        deploymentId: 'local-v1',
        deployment: { origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337,
          pool, finalityMode: 'finalized' as const },
        env: env as unknown as import('../src/index.js').ServiceEnv,
      }),
      readRewardFunds: async () => 10n,
      scheduleAlarm: async () => {},
    };
    const accepted = await route!.handle(request, context);
    const retried = await route!.handle(request, context);
    const retryWhileFundsUnknown = await route!.handle(request, {
      ...context, readRewardFunds: async () => undefined,
    });
    expect(accepted.status).toBe(200);
    expect(retried.status).toBe(200);
    expect(retryWhileFundsUnknown.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ reward: { requestId: id, amountWei: '4' } });
    expect(state.storage.sql.exec<{ amount_wei: string }>('SELECT amount_wei FROM reward_reservations').toArray())
      .toEqual([{ amount_wei: '4' }]);
  });
});
