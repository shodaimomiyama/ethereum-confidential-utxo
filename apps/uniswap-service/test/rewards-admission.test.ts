import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { rewardExtension } from '../src/rewards/extension.js';
import { makeServiceContext } from '../src/extensions.js';
import { recipientInfoTypedData } from '@confidential-utxo/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { admitReward, rewardLedgerVersion } from '../src/rewards/store.js';
import { initializeEnvironment } from '../src/recovery.js';
import { setRewardAvailability } from '../src/rewards/availability.js';

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
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
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
    state.storage.sql.exec(`UPDATE reward_requests SET status = 'received',
      state_version = state_version + 1 WHERE request_id = ?`, id);
    state.storage.sql.exec('UPDATE reward_reservations SET released = 1 WHERE request_id = ?', id);
    const secondId = `0x${'bb'.repeat(32)}`;
    const next = parseApiRequest('POST', '/v1/rewards', {
      scope, requestId: secondId, amountWei: '4',
      recipientInfo: { owner: account.address, publicKey: key, signature },
    });
    let releaseFunds!: (value: bigint) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const funds = new Promise<bigint>((resolve) => { releaseFunds = resolve; });
    const response = route!.handle(next, { ...context, readRewardFunds: async () => {
      started();
      return funds;
    } });
    await waiting;
    setRewardAvailability(state.storage, 'local-v1', 'operator-stopped');
    releaseFunds(10n);
    expect((await response).status).toBe(503);
    expect(state.storage.sql.exec<{ request_id: string }>(
      'SELECT request_id FROM reward_requests WHERE request_id = ?', secondId).toArray()).toEqual([]);
  });
});

it('rejects a stale funds observation after a prior distribution settles', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-admission-stale-funds'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    const make = (owner: string, id: string, amountWei: bigint) => parseApiRequest('POST', '/v1/rewards', {
      scope: { deploymentId: 'local-v1', owner }, requestId: `0x${id.repeat(64)}`,
      amountWei: amountWei.toString(), recipientInfo: { owner,
        publicKey: `0x${'33'.repeat(32)}`, signature: `0x${'44'.repeat(65)}` },
    }).reward!;
    const a = make(`0x${'11'.repeat(20)}`, 'a', 6n);
    const b = make(`0x${'22'.repeat(20)}`, 'b', 8n);
    expect(admitReward(state.storage, a, 10n).kind).toBe('accepted');
    const version = rewardLedgerVersion(state.storage, 'local-v1');
    state.storage.sql.exec("UPDATE reward_requests SET status = 'finalized', state_version = state_version + 1 WHERE request_id = ?", a.requestId);
    state.storage.sql.exec('UPDATE reward_reservations SET released = 1 WHERE request_id = ?', a.requestId);
    expect(admitReward(state.storage, b, 10n, { expectedVersion: version }).kind).toBe('unknown');
  });
});

it('rejects a new request when a previously finalized cancellation has disappeared', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-admission-cancel-reorg'));
  await stub.fetch('https://site.test/v1/operations');
  const account = privateKeyToAccount(generatePrivateKey());
  const pool = '0x0000000000000000000000000000000000000001';
  const publicKey = `0x${'33'.repeat(32)}` as `0x${string}`;
  const unsigned = { chainId: 31337n, pool: pool as `0x${string}`, owner: account.address,
    receivePublicKey: publicKey, receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
  const signature = await account.signTypedData(recipientInfoTypedData(
    { chainId: 31337n, pool: pool as `0x${string}` }, unsigned, account.address));
  const scope = { deploymentId: 'local-v1', owner: account.address };
  const request = parseApiRequest('POST', '/v1/rewards', {
    scope, requestId: `0x${'aa'.repeat(32)}`, amountWei: '4',
    recipientInfo: { owner: account.address, publicKey, signature },
  });
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const ended = `0x${'bb'.repeat(32)}`;
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id,
      amount_wei, recipient_info_json, content_hash, status, operation_id)
      VALUES ('local-v1', ?, ?, '1', '{}', 'hash', 'ended-without-distribution', ?)`,
    `0x${'22'.repeat(20)}`, ended, `0x${'cc'.repeat(32)}`);
    state.storage.sql.exec(`INSERT INTO reward_cancellations (deployment_id, request_id,
      phase, operation_id, input_id, encrypted_draft, checkpoint_hash)
      VALUES ('local-v1', ?, 'raw-saved', ?, ?, 'encrypted', ?)`, ended,
    `0x${'dd'.repeat(32)}`, `0x${'ee'.repeat(32)}`, `0x${'ff'.repeat(32)}`);
    const point = { number: 2n, hash: `0x${'11'.repeat(32)}`, mode: 'local-simulated' as const };
    const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
    const route = rewardExtension.routes.find((entry) => entry.route === 'POST /v1/rewards')!;
    const response = await route.handle(request, { ...makeServiceContext(state.storage,
      { generation: 'test-g1', stopped: false }, request.scope, {
        deploymentId: 'local-v1', deployment: { origin: 'https://site.test',
          siweUri: 'https://site.test/', chainId: 31337, pool,
          finalityMode: 'local-simulated' }, env: env as unknown as import('../src/index.js').ServiceEnv,
      }), readRewardFunds: async () => 10n,
      readRewardHistory: async () => ({ getFinalizedCheckpoint: async () => point,
        getContext: async () => bound({ deploymentBlock: 1n }),
        getOperations: async () => bound([]) } as unknown as import('@confidential-utxo/core').HistoryPort) });
    expect(response.status).toBe(503);
    expect(state.storage.sql.exec<{ request_id: string }>(
      'SELECT request_id FROM reward_requests WHERE request_id = ?', request.reward!.requestId).toArray())
      .toEqual([]);
  });
});
