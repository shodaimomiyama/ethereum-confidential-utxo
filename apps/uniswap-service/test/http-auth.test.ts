import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { expect, it } from 'vitest';
import worker from '../src/index.js';
import type { ServiceEnv } from '../src/index.js';
import type { UniswapServiceObject } from '../src/durable-object.js';
import { putOperation, releaseOperation } from '../src/store.js';
import { parseApiResponse } from '@confidential-utxo/uniswap';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';

const serviceEnv = env as unknown as ServiceEnv;

function post(path: string, body: unknown, origin = 'https://site.test', cookie?: string): Request {
  return new Request(`https://site.test${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

it('authenticates through the Worker and returns only the owner records', async () => {
  const stub = serviceEnv.UNISWAP_STATE.get(serviceEnv.UNISWAP_STATE.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (object) => (object as UniswapServiceObject).initializeForDeployment('local-v1'));
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address };
  const challengeResponse = await worker.fetch(post('/v1/auth/challenge', { scope }), serviceEnv);
  expect(challengeResponse.status).toBe(200);
  expect(challengeResponse.headers.get('cache-control')).toBe('no-store');
  const challenge = await challengeResponse.json() as {
    challengeId: string; nonce: string; issuedAt: number; expiresAt: number;
  };
  const siweMessage = createSiweMessage({
    address: account.address, domain: 'site.test', uri: 'https://site.test/', version: '1',
    chainId: 31337, nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt),
  });
  const signature = await account.signMessage({ message: siweMessage });
  const verified = await worker.fetch(post('/v1/auth/verify', {
    scope, challengeId: challenge.challengeId, siweMessage, signature,
  }), serviceEnv);
  expect(verified.status).toBe(200);
  const setCookie = verified.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('Secure; HttpOnly; SameSite=Strict');
  const cookie = setCookie.split(';')[0]!;
  const query = `/v1/operations?deploymentId=local-v1&owner=${account.address}`;
  const own = await worker.fetch(new Request(`https://site.test${query}`, { headers: { cookie } }), serviceEnv);
  expect(own.status).toBe(200);
  expect((await own.json() as { records: unknown[] }).records).toEqual([]);
  const savedId = `0x${'73'.repeat(32)}`;
  const savedRecord = {
    scope, recordId: savedId, kind: 'pay', inputId: `0x${'74'.repeat(32)}`,
    operationId: savedId, paymentId: savedId, deadline: 600n, contentHash: savedId,
    encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    signatureStarted: false, attemptIds: [],
  } as unknown as OperationRecord;
  await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope as Scope,
    savedRecord, 0, { readInput: async () => 'owned-unspent' as const }));
  const ownWithRecord = await worker.fetch(new Request(`https://site.test${query}`, { headers: { cookie } }), serviceEnv);
  const listed = parseApiResponse('GET /v1/operations', ownWithRecord.status, await ownWithRecord.json());
  expect('records' in listed && listed.records[0]?.reservationState).toBe('active');
  const getResponse = await worker.fetch(new Request(`https://site.test/v1/operations/${savedId}?deploymentId=local-v1&owner=${account.address}`, {
    headers: { cookie },
  }), serviceEnv);
  const fetched = parseApiResponse('GET /v1/operations/{id}', getResponse.status, await getResponse.json());
  expect('record' in fetched && fetched.record.recordId).toBe(savedId);
  expect('reservationState' in fetched && fetched.reservationState).toBe('active');
  const releasedRecord = { ...savedRecord,
    encryptedBundle: { ...savedRecord.encryptedBundle, nonce: `0x${'01'.repeat(12)}` } };
  await runInDurableObject(stub, (_obj, state) => releaseOperation(state.storage, scope as Scope,
    releasedRecord, 1, { blockNumber: '10', blockHash: savedId as OperationRecord['recordId'], blockTimestamp: '601' }));
  const wireRecord = { ...releasedRecord, scope: undefined, deadline: '600' };
  const releaseResponse = await worker.fetch(post(`/v1/operations/${savedId}/release`, {
    scope, expectedRevision: 1, sealedRevision: 2, blockHash: savedId, record: wireRecord,
  }, 'https://site.test', cookie), serviceEnv);
  const retried = parseApiResponse('POST /v1/operations/{id}/release', releaseResponse.status,
    await releaseResponse.json());
  expect('reservationState' in retried && retried.reservationState).toBe('released');
  expect('revision' in retried && retried.revision).toBe(2);
  const other = await worker.fetch(new Request(`https://site.test/v1/operations?deploymentId=local-v1&owner=0x0000000000000000000000000000000000000002`, {
    headers: { cookie },
  }), serviceEnv);
  expect(other.status).toBe(403);
  const missingCookie = await worker.fetch(new Request(`https://site.test${query}`), serviceEnv);
  expect(missingCookie.status).toBe(401);
  const recordId = `0x${'71'.repeat(32)}`;
  const unavailable = await worker.fetch(new Request(`https://site.test/v1/operations/${recordId}`, {
    method: 'PUT', headers: { origin: 'https://site.test', cookie }, body: JSON.stringify({
      scope, expectedRevision: 0, record: {
        recordId, kind: 'withdraw', inputId: `0x${'72'.repeat(32)}`,
        operationId: recordId, contentHash: recordId,
        encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
        signatureStarted: false, attemptIds: [],
      },
    }),
  }), serviceEnv);
  expect(unavailable.status).toBe(503);
});

it('rejects cross-origin challenge and oversize JSON before creating state', async () => {
  const scope = { deploymentId: 'local-v1', owner: '0x0000000000000000000000000000000000000001' };
  const wrongOrigin = await worker.fetch(post('/v1/auth/challenge', { scope }, 'https://evil.test'), serviceEnv);
  expect(wrongOrigin.status).toBe(403);
  const tooLarge = await worker.fetch(post('/v1/auth/challenge', { scope, excess: 'x'.repeat(1_048_576) }), serviceEnv);
  expect(tooLarge.status).toBe(413);
  const missing = await worker.fetch(post('/v1/auth/challenge', { scope: { ...scope, deploymentId: 'unknown' } }), serviceEnv);
  expect(missing.status).toBe(503);
  const oversizedBundle = await worker.fetch(post(`/v1/operations/0x${'01'.repeat(32)}`, {
    scope, expectedRevision: 0,
    record: { recordId: `0x${'01'.repeat(32)}`, encryptedBundle: {
      ciphertext: 'A'.repeat(4 * Math.ceil(524_288 / 3) + 4),
    } },
  }), serviceEnv);
  expect(oversizedBundle.status).toBe(413);
  const id = `0x${'01'.repeat(32)}`;
  const crossOriginPut = await worker.fetch(new Request(`https://site.test/v1/operations/${id}`, {
    method: 'PUT', headers: { origin: 'https://evil.test' }, body: JSON.stringify({
    scope, expectedRevision: 0, record: {
      recordId: id, kind: 'withdraw', inputId: id, operationId: id, contentHash: id,
      encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
      signatureStarted: false, attemptIds: [],
    },
  }), }), serviceEnv);
  expect(crossOriginPut.status).toBe(403);
});
