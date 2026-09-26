import { expect, it } from 'vitest';
import { createPaymentClient, parseOperationRecord, type PaymentPorts, type PreparedPay, type Scope } from '@confidential-utxo/uniswap';
import { createMemoryReservationPort, createMockHttp, createMemoryStore, createManualClock } from '@confidential-utxo/uniswap/testing';
import { createHttpClient } from '../../src/live/http.js';
import { createReservationPort } from '../../src/live/reservations.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'22'.repeat(32)}`;
const record = parseOperationRecord({ kind: 'pay', recordId: id, inputId: id, operationId: id, paymentId: id,
  contentHash: id, deadline: '600', signatureStarted: false, attemptIds: [],
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'01'.repeat(12)}`, tag: `0x${'02'.repeat(16)}` } }, scope);

// #30 trusted history is absent. #53 supplies durable reservation semantics here;
// the fixture enriches its legacy responses, never the production adapter.
async function setup(options: { lostAck?: boolean; refuse?: boolean } = {}) {
  const calls: string[] = [];
  const store = createMemoryReservationPort();
  const mock = createMockHttp({ store: createMemoryStore(), clock: createManualClock(0), reservations: store });
  const post = (path: string, body: unknown) => mock.fetch(new Request(`https://mock.invalid${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
  const challenge = await (await post('/v1/auth/challenge', { scope })).json() as { challengeId: string };
  const login = await post('/v1/auth/verify', { scope, challengeId: challenge.challengeId,
    siweMessage: 'synthetic SIWE', signature: `0x${'aa'.repeat(65)}` });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  let loseAck = options.lostAck;
  const http = createHttpClient({ origin: 'https://mock.invalid', transport: async request => {
    const headers = new Headers(request.headers); headers.set('cookie', cookie);
    if (request.method === 'GET') calls.push(`get:${new URL(request.url).pathname.split('/').at(-1)}`);
    const response = await mock.fetch(new Request(request, { headers }));
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) return Response.json(body, { status: response.status });
    if (request.method === 'PUT') {
      calls.push(`ack:${body.revision}:${(body.record as { signatureStarted: boolean }).signatureStarted}`);
      if (loseAck) { loseAck = false; calls.push('lost-ack'); throw new Error('disconnect'); }
    }
    return Response.json({ ...body, status: 'reserved', stateVersion: body.revision });
  } });
  const prepared: PreparedPay = { record, privateBytes: new Uint8Array([1, 2]), poolAuthorization: { operationId: record.operationId },
    quote: { startedAtMs: 0, blockHash: record.recordId, blockNumber: 1n, inputWei: 1n, quoteOut: 99n } };
  const ports: PaymentPorts = {
    reservations: createReservationPort(http), preparePay: async () => prepared,
    prepareFullWithdraw: async () => { throw new Error('unused'); }, refreshPay: async value => value,
    validatePrepared: async () => {}, currentScope: () => scope, clock: { now: () => 0 }, latestBlockTime: async () => 100n,
    encrypt: async (_data, context) => ({ ciphertext: 'AQID', nonce: `0x${String(context.revision).padStart(2, '0').repeat(12)}`, tag: `0x${'01'.repeat(16)}` }),
    sealContent: () => new Uint8Array([1, 2, 3]),
    signPool: async () => { calls.push('sign-pool'); if (options.refuse) throw new Error('USER_REFUSED'); return '0x11'; },
    signPayment: async () => { calls.push('sign-payment'); return '0x22'; },
    createAttempt: () => 'attempt-1' as never,
    submit: async () => { calls.push('submit'); return { kind: 'unknown' }; },
  };
  return { client: createPaymentClient(ports), prepared, calls, store };
}
it.each([false, true])('uses real #55 ordering and original ID after lost ACK=%s', async lostAck => {
  const fixture = await setup({ lostAck });
  const { client, prepared, calls, store } = fixture;
  const result = await client.authorizePay(prepared, record.contentHash);
  expect(result.chainOutcome).toBe('unknown');
  expect(calls.slice(0, lostAck ? 6 : 4)).toEqual(lostAck
    ? ['ack:1:false', 'lost-ack', `get:${id}`, 'ack:2:true', 'sign-pool', 'sign-payment']
    : ['ack:1:false', 'ack:2:true', 'sign-pool', 'sign-payment']);
  expect((await store.get(scope, record.recordId))?.record.attemptIds).toEqual(['attempt-1']);
  await expect(client.authorizePay(prepared, record.contentHash)).rejects.toThrow();
  expect(calls.filter(call => call === 'sign-pool')).toHaveLength(1);
  expect((await store.list(scope)).records).toHaveLength(1);
});
it('keeps revision 2 reservation after sign refusal and blocks a second authorization', async () => {
  const { client, prepared, calls, store } = await setup({ refuse: true });
  await expect(client.authorizePay(prepared, record.contentHash)).rejects.toThrow('USER_REFUSED');
  expect(calls).toEqual(['ack:1:false', 'ack:2:true', 'sign-pool']);
  expect(await store.get(scope, record.recordId)).toMatchObject({ revision: 2, reservationState: 'active', record: { signatureStarted: true } });
  await expect(client.authorizePay(prepared, record.contentHash)).rejects.toThrow();
  expect(calls.filter(call => call === 'sign-pool')).toHaveLength(1);
  expect(calls).not.toContain('submit');
});
