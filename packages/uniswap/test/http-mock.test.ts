import { expect, it } from 'vitest';
import { createManualClock } from '../src/testing/clock.js';
import { createMockHttp } from '../src/testing/http.js';
import { createMemoryStore } from '../src/testing/store.js';
import type { Scope } from '../src/domain.js';

const owner = `0x${'11'.repeat(20)}`;
const other = `0x${'22'.repeat(20)}`;
const id = `0x${'33'.repeat(32)}`;
const inputId = `0x${'44'.repeat(32)}`;
const scope = { deploymentId: 'local-v1', owner };
const sig = `0x${'aa'.repeat(65)}`;
const bundle = { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` };
const record = { recordId: id, kind: 'pay', inputId, operationId: id, paymentId: id,
  deadline: '600', contentHash: id, encryptedBundle: bundle, signatureStarted: false, attemptIds: [] };
const reward = { scope, requestId: id, amountWei: '1', recipientInfo: { owner, publicKey: inputId, signature: sig } };

function request(path: string, method = 'GET', body?: unknown, cookie?: string): Request {
  return new Request(`https://mock.invalid${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(http: ReturnType<typeof createMockHttp>, forScope = scope): Promise<string> {
  const challenge = await http.fetch(request('/v1/auth/challenge', 'POST', { scope: forScope }));
  expect(challenge.status).toBe(200);
  const challengeBody = await challenge.json() as { challengeId: string };
  const verify = await http.fetch(request('/v1/auth/verify', 'POST', {
    scope: forScope, challengeId: challengeBody.challengeId, siweMessage: 'synthetic SIWE', signature: sig,
  }));
  expect(verify.status).toBe(200);
  return verify.headers.get('set-cookie')?.split(';')[0] ?? '';
}

it('serves all eight routes through Fetch and keeps owner scope', async () => {
  const store = createMemoryStore();
  const http = createMockHttp({ store, clock: createManualClock(0) });
  const cookie = await login(http);
  const put = await http.fetch(request(`/v1/operations/${id}`, 'PUT', { scope, expectedRevision: 0, record }, cookie));
  expect(put.status).toBe(200);
  const operations = await http.fetch(request(`/v1/operations?deploymentId=local-v1&owner=${owner}`, 'GET', undefined, cookie));
  expect((await operations.json() as { records: unknown[] }).records).toHaveLength(1);
  const post = await http.fetch(request('/v1/rewards', 'POST', reward, cookie));
  expect(post.status).toBe(200);
  const list = await http.fetch(request(`/v1/rewards?deploymentId=local-v1&owner=${owner}`, 'GET', undefined, cookie));
  expect((await list.json() as { rewards: unknown[] }).rewards).toHaveLength(1);
  const detail = await http.fetch(request(`/v1/rewards/${id}?deploymentId=local-v1&owner=${owner}`, 'GET', undefined, cookie));
  expect(detail.status).toBe(200);
  store.control.setRewardFinalized(scope as Scope, id as never, inputId as never, id as never);
  const received = await http.fetch(request(`/v1/rewards/${id}/received`, 'POST', { scope, outputId: inputId, blockHash: id }, cookie));
  expect((await received.json() as { reward: { status: string } }).reward.status).toBe('received');
});

it('persists an operation before a lost ACK and recovers it under the original ID', async () => {
  const store = createMemoryStore();
  const http = createMockHttp({ store, clock: createManualClock(0) });
  const cookie = await login(http);
  store.control.loseNextAck('PUT /v1/operations/{id}');
  await expect(http.fetch(request(`/v1/operations/${id}`, 'PUT', { scope, expectedRevision: 0, record }, cookie))).rejects.toThrowError(/ACK_LOST/);
  expect(store.operations.list(scope as Scope)).toHaveLength(1);
  const found = await http.fetch(request(`/v1/operations?deploymentId=local-v1&owner=${owner}`, 'GET', undefined, cookie));
  expect((await found.json() as { records: { record: { recordId: string } }[] }).records[0]?.record.recordId).toBe(id);
  expect(store.control.journal().filter((x) => x.kind === 'operation-put')).toHaveLength(1);
});

it('keeps one reward when its ACK is lost and hides it from another owner', async () => {
  const store = createMemoryStore();
  const http = createMockHttp({ store, clock: createManualClock(0) });
  const cookie = await login(http);
  store.control.loseNextAck('POST /v1/rewards');
  await expect(http.fetch(request('/v1/rewards', 'POST', reward, cookie))).rejects.toThrowError(/ACK_LOST/);
  expect((await http.fetch(request('/v1/rewards', 'POST', reward, cookie))).status).toBe(200);
  expect(store.control.journal().filter((x) => x.kind === 'reward-create')).toHaveLength(1);
  const otherCookie = await login(http, { deploymentId: 'local-v1', owner: other });
  expect((await http.fetch(request(`/v1/rewards/${id}?deploymentId=local-v1&owner=${other}`, 'GET', undefined, otherCookie))).status).toBe(404);
});

it('uses one-use five-minute challenges and thirty-minute sessions', async () => {
  const clock = createManualClock(0);
  const http = createMockHttp({ store: createMemoryStore(), clock });
  const response = await http.fetch(request('/v1/auth/challenge', 'POST', { scope }));
  const { challengeId } = await response.json() as { challengeId: string };
  const body = { scope, challengeId, siweMessage: 'synthetic SIWE', signature: sig };
  clock.set(300001);
  expect((await http.fetch(request('/v1/auth/verify', 'POST', body))).status).toBe(401);
  const cookie = await login(http);
  const replayChallenge = await http.fetch(request('/v1/auth/challenge', 'POST', { scope }));
  const replayId = (await replayChallenge.json() as { challengeId: string }).challengeId;
  const replayBody = { ...body, challengeId: replayId };
  expect((await http.fetch(request('/v1/auth/verify', 'POST', replayBody))).status).toBe(200);
  const replay = await http.fetch(request('/v1/auth/verify', 'POST', replayBody));
  expect((await replay.json() as { error: { code: string } }).error.code).toBe('CHALLENGE_USED');
  clock.set(300001 + 1800001);
  expect((await http.fetch(request(`/v1/operations?deploymentId=local-v1&owner=${owner}`, 'GET', undefined, cookie))).status).toBe(401);
});

it('reports a stale expected revision separately from a different reservation', async () => {
  const store = createMemoryStore();
  const http = createMockHttp({ store, clock: createManualClock(0) });
  const cookie = await login(http);
  await http.fetch(request(`/v1/operations/${id}`, 'PUT', { scope, expectedRevision: 0, record }, cookie));
  const revision = await http.fetch(request(`/v1/operations/${id}`, 'PUT', {
    scope, expectedRevision: 0, record: { ...record, signatureStarted: true },
  }, cookie));
  expect(revision.status).toBe(409);
  expect((await revision.json() as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
});

it('separates 409 conflicts, 503 outage, and secret-free errors', async () => {
  const store = createMemoryStore();
  const http = createMockHttp({ store, clock: createManualClock(0) });
  const cookie = await login(http);
  await http.fetch(request(`/v1/operations/${id}`, 'PUT', { scope, expectedRevision: 0, record }, cookie));
  const conflict = await http.fetch(request(`/v1/operations/${id}`, 'PUT', {
    scope, expectedRevision: 1, record: { ...record, contentHash: inputId },
  }, cookie));
  expect(conflict.status).toBe(409);
  expect((await conflict.json() as { error: { code: string } }).error.code).toBe('RESERVATION_CONFLICT');
  store.control.setUnavailable(true);
  const outage = await http.fetch(request('/v1/rewards', 'POST', reward, cookie));
  expect(outage.status).toBe(503);
  expect(JSON.stringify(await outage.json())).not.toContain(sig);
});
