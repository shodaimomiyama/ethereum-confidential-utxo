import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { expect, it } from 'vitest';
import { parseApiResponse, type OperationRecord, type Scope } from '@confidential-utxo/uniswap';
import type { Checkpoint, Context, HistoryPort } from '@confidential-utxo/core';
import worker from '../src/index.js';
import type { ServiceEnv } from '../src/index.js';
import type { UniswapServiceObject } from '../src/durable-object.js';
import { saveBeforeAuthorization } from '../../uniswap-web/src/live/record-crypto.js';
import type { HttpClient } from '../../uniswap-web/src/live/http.js';
import { putOperation } from '../src/store.js';
import { registerCoreHistoryProvider } from '../src/core-reader.js';

const serviceEnv = env as unknown as ServiceEnv;
const recordId = `0x${'b1'.repeat(32)}`;
const blockHash = `0x${'c1'.repeat(32)}` as const;

async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
  const scope = { deploymentId: 'local-v1', owner: account.address };
  const challengeResponse = await worker.fetch(new Request('https://site.test/v1/auth/challenge', {
    method: 'POST', headers: { origin: 'https://site.test' }, body: JSON.stringify({ scope }),
  }), serviceEnv);
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json() as { challengeId: string; nonce: string; issuedAt: number; expiresAt: number };
  const siweMessage = createSiweMessage({
    address: account.address, domain: 'site.test', uri: 'https://site.test/', version: '1', chainId: 31337,
    nonce: challenge.nonce, issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt),
  });
  const signature = await account.signMessage({ message: siweMessage });
  const response = await worker.fetch(new Request('https://site.test/v1/auth/verify', {
    method: 'POST', headers: { origin: 'https://site.test' },
    body: JSON.stringify({ scope, challengeId: challenge.challengeId, siweMessage, signature }),
  }), serviceEnv);
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

it('restores a committed operation in a second authenticated browser session', async () => {
  const stub = serviceEnv.UNISWAP_STATE.get(serviceEnv.UNISWAP_STATE.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (object) => (object as UniswapServiceObject).initializeForDeployment('local-v1'));
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const firstCookie = await login(account);
  const point: Checkpoint = { number: 10n, hash: blockHash, mode: 'finalized' };
  const context: Context = {
    chainId: 31337n, pool: '0x0000000000000000000000000000000000000001',
    deploymentBlock: 1n, verifier: '0x0000000000000000000000000000000000000001',
    parametersHash: blockHash, finalityMode: 'finalized',
  };
  const observed = <T,>(value: T) => ({ complete: true as const, blockHash, value });
  registerCoreHistoryProvider(() => ({
    getFinalizedCheckpoint: async () => point,
    getContext: async () => observed(context),
    getUtxo: async () => observed({ exists: true, owner: account.address, commitment: { x: 1n, y: 2n } }),
    getLatestHeader: async () => ({ number: 10n, hash: blockHash }),
    getLatestUtxo: async () => observed({ exists: true, owner: account.address, commitment: { x: 1n, y: 2n } }),
    getCanonicalHeader: async () => observed({ number: 10n, hash: blockHash }),
  } as unknown as HistoryPort));
  const record = {
    scope, recordId, inputId: `0x${'b2'.repeat(32)}`, operationId: recordId,
    kind: 'pay', paymentId: recordId, deadline: '600', contentHash: recordId,
    encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
    signatureStarted: false, attemptIds: [],
  };
  // This test injects a trusted HistoryPort; #30's RPC adapter is exercised by its package tests.
  const saved = await worker.fetch(new Request(`https://site.test/v1/operations/${recordId}`, {
    method: 'PUT', headers: { origin: 'https://site.test', cookie: firstCookie },
    body: JSON.stringify({ scope, expectedRevision: 0, record }),
  }), serviceEnv);
  expect(saved.status).toBe(200);
  const savedBody = await saved.json() as { revision: number; stateVersion: number; status: string };
  expect(savedBody).toMatchObject({ revision: 1, stateVersion: 1, status: 'reserved' });
  // A lost PUT acknowledgement is resolved with the original record ID.
  const lookup = await worker.fetch(new Request(
    `https://site.test/v1/operations/${recordId}?deploymentId=local-v1&owner=${account.address}`,
    { headers: { cookie: firstCookie } },
  ), serviceEnv);
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toMatchObject({ ...savedBody, reservationState: 'active' });
  // A committed PUT with a lost ACK is recoverable only while its exact input lock remains active.
  const calls: string[] = [];
  const http = { async call(route: string, input: { body?: unknown; id?: string }) {
    calls.push(route);
    const method = route.startsWith('PUT ') ? 'PUT' : 'GET';
    const response = await worker.fetch(new Request(`https://site.test/v1/operations/${input.id}?deploymentId=local-v1&owner=${account.address}`, {
      method, headers: { origin: 'https://site.test', cookie: firstCookie },
      ...(method === 'PUT' ? { body: JSON.stringify(input.body) } : {}),
    }), serviceEnv);
    expect(response.status).toBe(200);
    if (method === 'PUT') throw new Error('ACK_LOST_AFTER_COMMIT');
    return parseApiResponse('GET /v1/operations/{id}', response.status, await response.json());
  } } as HttpClient;
  const recovered = await saveBeforeAuthorization(http, { ...record, deadline: 600n } as unknown as OperationRecord, 0);
  expect(recovered).toMatchObject({ revision: 1, stateVersion: 1, status: 'reserved',
    reservationState: 'active', record: { recordId } });
  expect(calls).toEqual(['PUT /v1/operations/{id}', 'GET /v1/operations/{id}']);
  const release = await worker.fetch(new Request(`https://site.test/v1/operations/${recordId}/release`, {
    method: 'POST', headers: { origin: 'https://site.test', cookie: firstCookie },
    body: JSON.stringify({ scope, expectedRevision: 1, sealedRevision: 2, blockHash,
      record: { ...record, encryptedBundle: { ...record.encryptedBundle, nonce: `0x${'01'.repeat(12)}` } },
    }),
  }), serviceEnv);
  expect(release.status).toBe(503);
  expect(await release.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  const competingId = `0x${'b3'.repeat(32)}`;
  const competing = await worker.fetch(new Request(`https://site.test/v1/operations/${competingId}`, {
    method: 'PUT', headers: { origin: 'https://site.test', cookie: firstCookie },
    body: JSON.stringify({ scope, expectedRevision: 0, record: {
      ...record, recordId: competingId, kind: 'withdraw', operationId: competingId,
      paymentId: undefined, deadline: undefined,
    } }),
  }), serviceEnv);
  expect(competing.status).toBe(409);
  const query = `https://site.test/v1/operations?deploymentId=local-v1&owner=${account.address}`;
  const first = await worker.fetch(new Request(query, { headers: { cookie: firstCookie } }), serviceEnv);
  expect(first.status).toBe(200);
  expect((await first.json() as { records: unknown[] }).records[0]).toMatchObject({
    revision: 1, stateVersion: 1, status: 'reserved', record: { recordId },
  });
  const secondCookie = await login(account);
  const second = await worker.fetch(new Request(query, { headers: { cookie: secondCookie } }), serviceEnv);
  expect(second.status).toBe(200);
  expect((await second.json() as { records: { record: { recordId: string } }[] }).records[0]?.record.recordId).toBe(recordId);
  const forbidden = await worker.fetch(new Request(query.replace(account.address, `0x${'bb'.repeat(20)}`),
    { headers: { cookie: secondCookie } }), serviceEnv);
  expect(forbidden.status).toBe(403);
  const lookupUrl = `https://site.test/v1/operations/${recordId}?deploymentId=local-v1&owner=${account.address}`;
  expect((await worker.fetch(new Request(lookupUrl), serviceEnv)).status).toBe(401);
  const another = privateKeyToAccount(generatePrivateKey());
  const otherCookie = await login(another);
  expect((await worker.fetch(new Request(lookupUrl, { headers: { cookie: otherCookie } }), serviceEnv)).status).toBe(403);
  const foreign = await worker.fetch(new Request(lookupUrl.replace(account.address, another.address),
    { headers: { cookie: otherCookie } }), serviceEnv);
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec("UPDATE operations SET status = 'finalized-success', state_version = 9, checkpoint_block_number = '10', checkpoint_block_hash = ?, checkpoint_block_timestamp = '600' WHERE record_id = ?", blockHash, recordId);
  });
  const completed = await worker.fetch(new Request(lookupUrl, { headers: { cookie: secondCookie } }), serviceEnv);
  expect(completed.status).toBe(200);
  const parsed = parseApiResponse('GET /v1/operations/{id}', completed.status, await completed.json());
  expect(parsed).toMatchObject({ revision: 1, stateVersion: 9, status: 'finalized-success',
    checkpoint: { blockNumber: '10', blockHash, blockTimestamp: '600' } });
  expect(parsed).not.toHaveProperty('reservationState');
  await runInDurableObject(stub, async (_object, state) => {
    for (let n = 1; n <= 101; n++) {
      const id = `0x${n.toString(16).padStart(64, '0')}`;
      const record = { scope, recordId: id, inputId: id, operationId: id, kind: 'withdraw', contentHash: id,
        encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
        signatureStarted: false, attemptIds: [] } as unknown as OperationRecord;
      await putOperation(state.storage, scope, record, 0, { readInput: async () => 'owned-unspent' });
    }
  });
  const pagesQuery = `https://site.test/v1/operations?deploymentId=local-v1&owner=${account.address}`;
  const firstResponse = await worker.fetch(new Request(pagesQuery, { headers: { cookie: secondCookie } }), serviceEnv);
  const firstPage = parseApiResponse('GET /v1/operations', firstResponse.status, await firstResponse.json());
  if ('error' in firstPage) throw new Error(firstPage.error.code);
  expect(firstPage.records).toHaveLength(100);
  expect(firstPage.nextCursor).toBe(firstPage.records[99]!.record.recordId);
  const secondResponse = await worker.fetch(new Request(`${pagesQuery}&cursor=${firstPage.nextCursor}`, { headers: { cookie: secondCookie } }), serviceEnv);
  const secondPage = parseApiResponse('GET /v1/operations', secondResponse.status, await secondResponse.json());
  if ('error' in secondPage) throw new Error(secondPage.error.code);
  expect(secondPage.records).toHaveLength(2);
  expect(secondPage.nextCursor).toBeUndefined();
  expect(new Set([...firstPage.records, ...secondPage.records].map(item => item.record.recordId)).size).toBe(102);
  const unlockedId = `0x${'1'.padStart(64, '0')}`;
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec('DELETE FROM active_reservations WHERE record_id = ?', unlockedId);
  });
  const unlocked = await worker.fetch(new Request(
    `https://site.test/v1/operations/${unlockedId}?deploymentId=local-v1&owner=${account.address}`,
    { headers: { cookie: secondCookie } },
  ), serviceEnv);
  expect(unlocked.status).toBe(200);
  const unlockedBody = parseApiResponse('GET /v1/operations/{id}', 200, await unlocked.json());
  expect(unlockedBody).toMatchObject({ status: 'reserved', record: { recordId: unlockedId } });
  expect(unlockedBody).not.toHaveProperty('reservationState');
  // The original record sorts after the 100-item first page. A finalized result
  // must not be interpreted as an active reservation after a lost PUT ACK.
  calls.length = 0;
  await expect(saveBeforeAuthorization(http, { ...record, deadline: 600n } as unknown as OperationRecord, 0))
    .rejects.toThrow('OPERATION_SAVE_UNCONFIRMED');
  expect(calls).toEqual(['PUT /v1/operations/{id}', 'GET /v1/operations/{id}']);
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec("UPDATE environment_state SET status = 'stopped' WHERE id = 1");
  });
  const stopped = await worker.fetch(new Request(lookupUrl, { headers: { cookie: secondCookie } }), serviceEnv);
  expect(stopped.status).toBe(503);
  expect(await stopped.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
});
