import { expect, it, vi } from 'vitest';
import { parseApiRequest, type ApiRequestBodyMap, type Scope, type Bytes32, type InputId, type OperationId, type PaymentId } from '@confidential-utxo/uniswap';
import { assertHttpConformance, createManualClock, createMemoryStore, createMockHttp } from '@confidential-utxo/uniswap/testing';
import { createHttpClient, HttpFailure } from '../../src/live/http.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'33'.repeat(32)}` as Bytes32;
const origin = 'https://mock.invalid';

it('runs all #53 HTTP conformance scenarios through the live client', async () => {
  await assertHttpConformance(scenario => {
    const clock = createManualClock(0);
    const store = createMemoryStore(scenario.seed);
    const mock = createMockHttp({ store, clock });
    return { clock, store, rejectAuth: mock.control.rejectNextAuth, transport: async request => {
      const body = request.method === 'GET' ? undefined : await request.json();
      const parsed = parseApiRequest(request.method, request.url, body);
      let response: Response | undefined;
      let transportError: unknown;
      let calls = 0;
      const client = createHttpClient({ origin, transport: async outgoing => {
        calls++;
        expect(outgoing.credentials).toBe('same-origin');
        expect(outgoing.redirect).toBe('error');
        const headers = new Headers(outgoing.headers);
        const cookie = request.headers.get('cookie');
        if (cookie) headers.set('cookie', cookie);
        try { response = await mock.fetch(new Request(outgoing, { headers })); }
        catch (error) { transportError = error; throw error; }
        return response.clone();
      } });
      try { await client.call(parsed.route, { scope: parsed.scope, id: parsed.id, body }); }
      catch (error) {
        if (transportError) { expect(error).toMatchObject({ kind: 'network' }); throw transportError; }
        expect(error).toBeInstanceOf(HttpFailure);
        expect(error).toMatchObject({ kind: 'api' });
        expect(response?.status).toBeGreaterThanOrEqual(400);
      } finally { expect(calls).toBe(1); }
      return response!;
    } };
  });
});

it.each([409, 503, 401])('returns parsed API failure for %s without exposing server text', async status => {
  const code = status === 409 ? 'REVISION_CONFLICT' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED';
  const transport = vi.fn(async () => Response.json({ error: { code, message: 'private server context', allowedActions: [] } }, { status }));
  const client = createHttpClient({ origin, transport });
  await expect(client.call('GET /v1/operations', { scope })).rejects.toMatchObject({ kind: 'api', code, message: code });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('rejects malformed JSON, malformed schemas and mixed-scope replies', async () => {
  for (const response of [new Response('{'), Response.json({}), Response.json({ rewards: [{ scope }] })]) {
    await expect(createHttpClient({ origin, transport: async () => response }).call('GET /v1/rewards', { scope })).rejects.toMatchObject({ kind: 'schema' });
  }
  const transport = vi.fn();
  await expect(createHttpClient({ origin, transport }).call('POST /v1/auth/challenge', { scope, body: { scope: { ...scope, deploymentId: 'other' as never } } })).rejects.toMatchObject({ kind: 'scope' });
  expect(transport).not.toHaveBeenCalled();
});

it('does not repeat a POST after server handling and disconnect', async () => {
  const transport = vi.fn(async () => { throw new Error('secret connection details'); });
  const body: ApiRequestBodyMap['POST /v1/rewards'] = { scope, requestId: id as never, amountWei: '1', recipientInfo: { owner: scope.owner, publicKey: id, signature: `0x${'aa'.repeat(65)}` } };
  await expect(createHttpClient({ origin, transport }).call('POST /v1/rewards', { scope, body })).rejects.toMatchObject({ kind: 'network', message: 'network' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('forwards abort and prevents requests for invalid IDs', async () => {
  const abort = new AbortController(); abort.abort();
  const transport = vi.fn(async (request: Request) => { request.signal.throwIfAborted(); return Response.json({}); });
  const client = createHttpClient({ origin, transport });
  await expect(client.call('GET /v1/operations', { scope, signal: abort.signal })).rejects.toMatchObject({ kind: 'abort' });
  await expect(client.call('GET /v1/rewards/{id}', { scope, id: '../escape' as Bytes32 })).rejects.toMatchObject({ kind: 'schema' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('rejects foreign owner/environment and different reward IDs in successful replies', async () => {
  const reward = { scope, requestId: id, amountWei: '1', recipientInfo: { owner: scope.owner, publicKey: id, signature: `0x${'aa'.repeat(65)}` }, status: 'accepted', attemptIds: [], txHashes: [] };
  for (const returned of [
    { ...reward, scope: { ...scope, deploymentId: 'foreign' } },
    { ...reward, scope: { ...scope, owner: `0x${'22'.repeat(20)}` }, recipientInfo: { ...reward.recipientInfo, owner: `0x${'22'.repeat(20)}` } },
    { ...reward, requestId: `0x${'44'.repeat(32)}` },
  ]) {
    const client = createHttpClient({ origin, transport: async () => Response.json({ reward: returned }) });
    await expect(client.call('GET /v1/rewards/{id}', { scope, id })).rejects.toMatchObject({ kind: 'scope' });
  }
  const client = createHttpClient({ origin, transport: async () => Response.json({ rewards: [{ ...reward, scope: { ...scope, deploymentId: 'foreign' } }] }) });
  await expect(client.call('GET /v1/rewards', { scope })).rejects.toMatchObject({ kind: 'scope' });
});

it('rejects an oversized release record before transport', async () => {
  const body: ApiRequestBodyMap['POST /v1/operations/{id}/release'] = {
    scope, expectedRevision: 1, sealedRevision: 2, blockHash: id,
    record: {
      recordId: id, kind: 'pay', inputId: id as unknown as InputId,
      operationId: id as unknown as OperationId, paymentId: id as unknown as PaymentId,
      deadline: '600', contentHash: id, signatureStarted: true, attemptIds: [],
      encryptedBundle: { ciphertext: 'A'.repeat(1_048_576), nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    },
  };
  const transport = vi.fn(async () => Response.json({ scope, record: body.record, revision: 2, reservationState: 'released' }));
  const client = createHttpClient({ origin, transport });
  await expect(client.call('POST /v1/operations/{id}/release', { scope, id, body }).then(() => 'sent')).rejects.toMatchObject({ kind: 'schema' });
  expect(transport).not.toHaveBeenCalled();
});

it('forwards a typed list cursor and rejects malformed or misplaced cursors before transport', async () => {
  const transport = vi.fn(async (request: Request) => {
    expect(new URL(request.url).searchParams.get('cursor')).toBe(id);
    return Response.json({ availability: 'healthy', records: [] });
  });
  const client = createHttpClient({ origin, transport });
  await client.call('GET /v1/operations', { scope, cursor: id });
  await expect(client.call('GET /v1/operations', { scope, cursor: 'bad' as Bytes32 })).rejects.toMatchObject({ kind: 'schema' });
  // Runtime boundary also rejects callers bypassing TypeScript.
  await expect(client.call('GET /v1/rewards', { scope, cursor: id } as never)).rejects.toMatchObject({ kind: 'schema' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('preserves rich GET metadata without inventing legacy reservation state', async () => {
  const record = { recordId: id, kind: 'withdraw', inputId: id, operationId: id, contentHash: id,
    encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    signatureStarted: true, attemptIds: [] };
  const checkpoint = { blockNumber: '12', blockHash: id, blockTimestamp: '600' };
  const client = createHttpClient({ origin, transport: async () => Response.json({ scope, record,
    revision: 2, stateVersion: 9, status: 'finalized-success', checkpoint }) });
  const result = await client.call('GET /v1/operations/{id}', { scope, id });
  expect(result).toMatchObject({ revision: 2, stateVersion: 9, status: 'finalized-success', checkpoint });
  expect(result).not.toHaveProperty('reservationState');
});
