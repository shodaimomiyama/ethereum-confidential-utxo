import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { Checkpoint, Context, HistoryPort } from '@confidential-utxo/core';
import worker from '../src/index.js';
import type { ServiceEnv } from '../src/index.js';
import type { UniswapServiceObject } from '../src/durable-object.js';
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
  expect((await first.json() as { records: { record: { recordId: string } }[] }).records[0]?.record.recordId).toBe(recordId);
  const secondCookie = await login(account);
  const second = await worker.fetch(new Request(query, { headers: { cookie: secondCookie } }), serviceEnv);
  expect(second.status).toBe(200);
  expect((await second.json() as { records: { record: { recordId: string } }[] }).records[0]?.record.recordId).toBe(recordId);
  const forbidden = await worker.fetch(new Request(query.replace(account.address, `0x${'bb'.repeat(20)}`),
    { headers: { cookie: secondCookie } }), serviceEnv);
  expect(forbidden.status).toBe(403);
});
