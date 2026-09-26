import { expect, it } from 'vitest';
import { createMockHttp } from '../src/testing/http.js';
import { createManualClock } from '../src/testing/clock.js';
import { createMemoryStore } from '../src/testing/store.js';
import { createMemoryReservationPort } from '../src/testing/reservation.js';
import { parseOperationRecord } from '../src/api.js';
import type { Scope } from '../src/domain.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const id = `0x${'33'.repeat(32)}`;
const inputId = `0x${'44'.repeat(32)}`;
const blockHash = `0x${'55'.repeat(32)}`;
const record = parseOperationRecord({
  kind: 'pay', recordId: id, scope, inputId, operationId: id, paymentId: id,
  contentHash: id, deadline: '600', signatureStarted: false, attemptIds: [],
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'01'.repeat(12)}`, tag: `0x${'02'.repeat(16)}` },
}, scope);

it('retrieves and releases one reserved record through authenticated HTTP', async () => {
  const reservations = createMemoryReservationPort({ verify: async () => ({
    finalized: true, blockTime: 601n, paymentSucceeded: false, inputUnspent: true, inputConsumed: false,
  }) });
  const http = createMockHttp({ store: createMemoryStore(), clock: createManualClock(0), reservations });
  const post = (path: string, body: unknown, cookie?: string) => http.fetch(new Request(`https://mock.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
  const challenge = await (await post('/v1/auth/challenge', { scope })).json() as { challengeId: string };
  const login = await post('/v1/auth/verify', {
    scope, challengeId: challenge.challengeId, siweMessage: 'synthetic SIWE', signature: `0x${'aa'.repeat(65)}`,
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeDefined();

  const put = await http.fetch(new Request(`https://mock.invalid/v1/operations/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ scope, expectedRevision: 0, sealedRevision: 1, record: { ...record, deadline: '600' } }),
  }));
  expect(put.status).toBe(200);

  const read = await http.fetch(new Request(`https://mock.invalid/v1/operations/${id}?deploymentId=local-v1&owner=${owner}`, { headers: { cookie: cookie! } }));
  expect(read.status).toBe(200);
  expect((await read.json() as { revision: number }).revision).toBe(1);

  const released = await post(`/v1/operations/${id}/release`, {
    scope, expectedRevision: 1, sealedRevision: 2, blockHash,
    record: { ...record, deadline: '600', encryptedBundle: { ...record.encryptedBundle, nonce: `0x${'03'.repeat(12)}` } },
  }, cookie);
  expect(released.status).toBe(200);
  expect((await released.json() as { reservationState: string }).reservationState).toBe('released');
  expect((await reservations.get(scope, id as never))?.revision).toBe(2);
  const list = await http.fetch(new Request(`https://mock.invalid/v1/operations?deploymentId=local-v1&owner=${owner}`, { headers: { cookie: cookie! } }));
  expect((await list.json() as { records: { reservationState: string }[] }).records[0]?.reservationState).toBe('released');
});
