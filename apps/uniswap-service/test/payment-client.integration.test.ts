import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createPaymentClient, parseOperationRecord, type Bytes32, type PaymentPorts, type PreparedPay, type Scope } from '@confidential-utxo/uniswap';
import type { Checkpoint, Context, HistoryPort } from '@confidential-utxo/core';
import worker, { type ServiceEnv } from '../src/index.js';
import type { UniswapServiceObject } from '../src/durable-object.js';
import { registerCoreHistoryProvider } from '../src/core-reader.js';
import { createHttpClient } from '../../uniswap-web/src/live/http.js';
import { createReservationPort } from '../../uniswap-web/src/live/reservations.js';

const serviceEnv = env as unknown as ServiceEnv;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Bytes32;
const blockHash = hash('c');

// Workerd rejects browser redirect:error; retain browser request semantics at construction.
const EdgeRequest = Request;
beforeAll(() => {
  vi.stubGlobal('Request', class extends EdgeRequest {
    readonly credentials: RequestCredentials;
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, { ...init, redirect: init?.redirect === 'error' ? 'manual' : init?.redirect });
      this.credentials = init?.credentials ?? 'same-origin';
    }
  });
});
afterAll(() => vi.unstubAllGlobals());

it('recovers a lost Workerd reservation ACK before signing and keeps the SQLite input lock', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const point: Checkpoint = { number: 10n, hash: blockHash, mode: 'finalized' };
  const context: Context = {
    chainId: 31337n, pool: '0x0000000000000000000000000000000000000001',
    deploymentBlock: 1n, verifier: '0x0000000000000000000000000000000000000001',
    parametersHash: blockHash, finalityMode: 'finalized',
  };
  const observed = <T,>(value: T) => ({ complete: true as const, blockHash, value });
  // This controlled #29 HistoryPort is trusted test input, not the unfinished #30 RPC adapter.
  registerCoreHistoryProvider(() => ({
    getFinalizedCheckpoint: async () => point,
    getContext: async () => observed(context),
    getUtxo: async () => observed({ exists: true, owner: account.address, commitment: { x: 1n, y: 2n } }),
    getLatestHeader: async () => ({ number: 10n, hash: blockHash }),
    getLatestUtxo: async () => observed({ exists: true, owner: account.address, commitment: { x: 1n, y: 2n } }),
    getCanonicalHeader: async () => observed({ number: 10n, hash: blockHash }),
  } as unknown as HistoryPort));

  const stub = serviceEnv.UNISWAP_STATE.get(serviceEnv.UNISWAP_STATE.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, object => (object as UniswapServiceObject).initializeForDeployment('local-v1'));
  const challengeResponse = await worker.fetch(new Request('https://site.test/v1/auth/challenge', {
    method: 'POST', headers: { origin: 'https://site.test' }, body: JSON.stringify({ scope }),
  }), serviceEnv);
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json() as { challengeId: string; nonce: string; issuedAt: number; expiresAt: number };
  const siweMessage = createSiweMessage({ address: account.address, domain: 'site.test', uri: 'https://site.test/',
    version: '1', chainId: 31337, nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt) });
  const signature = await account.signMessage({ message: siweMessage });
  const login = await worker.fetch(new Request('https://site.test/v1/auth/verify', {
    method: 'POST', headers: { origin: 'https://site.test' },
    body: JSON.stringify({ scope, challengeId: challenge.challengeId, siweMessage, signature }),
  }), serviceEnv);
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

  const recordId = hash('a');
  const inputId = hash('b');
  const record = parseOperationRecord({ kind: 'pay', recordId, inputId, operationId: recordId,
    paymentId: recordId, contentHash: recordId, deadline: '600', signatureStarted: false, attemptIds: [],
    encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'01'.repeat(12)}`, tag: `0x${'02'.repeat(16)}` },
  }, scope);
  const prepared: PreparedPay = { record, privateBytes: new Uint8Array([1, 2]),
    poolAuthorization: { operationId: record.operationId },
    quote: { startedAtMs: 0, blockHash, blockNumber: 10n, inputWei: 1n, quoteOut: 99n } };
  const events: string[] = [];
  let dropFirstAck = true;
  const http = createHttpClient({ origin: 'https://site.test', transport: async request => {
    const headers = new Headers(request.headers);
    headers.set('cookie', cookie);
    if (request.method !== 'GET') headers.set('origin', 'https://site.test');
    const response = await worker.fetch(new Request(request, { headers }), serviceEnv);
    if (request.method === 'PUT' && response.ok) {
      const saved = await response.clone().json() as { revision: number };
      events.push(`put:${saved.revision}`);
      if (dropFirstAck) { dropFirstAck = false; throw new Error('ACK_LOST_AFTER_COMMIT'); }
    }
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith(recordId)) events.push('get-original');
    return response;
  } });
  const reservations = createReservationPort(http);
  const ports: PaymentPorts = {
    reservations, preparePay: async () => prepared,
    prepareFullWithdraw: async () => { throw new Error('unused'); }, refreshPay: async value => value,
    validatePrepared: async () => {}, currentScope: () => scope, clock: { now: () => 0 },
    latestBlockTime: async () => 100n,
    encrypt: async (_data, binding) => ({ ciphertext: 'AQID',
      nonce: `0x${binding.revision.toString(16).padStart(2, '0').repeat(12)}`,
      tag: `0x${'02'.repeat(16)}` }),
    sealContent: () => new Uint8Array([1, 2, 3]),
    signPool: async () => {
      expect((await reservations.get(scope, recordId))?.record.signatureStarted).toBe(true);
      events.push('sign-pool');
      throw new Error('USER_REFUSED');
    },
    signPayment: async () => { throw new Error('must not sign payment'); },
    createAttempt: () => { throw new Error('must not create attempt'); },
    submit: async () => { throw new Error('must not submit'); },
  };
  const client = createPaymentClient(ports);
  await expect(client.authorizePay(prepared, record.contentHash)).rejects.toThrow('USER_REFUSED');
  expect(events).toEqual(['put:1', 'get-original', 'put:2', 'get-original', 'sign-pool']);
  expect(await reservations.get(scope, recordId)).toMatchObject({ revision: 2, reservationState: 'active',
    record: { signatureStarted: true, attemptIds: [] } });
  const second = parseOperationRecord({ ...record, deadline: '600', recordId: hash('d'), operationId: hash('d'),
    paymentId: hash('d'), contentHash: hash('d') }, scope);
  await expect(reservations.reserve(second, 0, 1)).rejects.toMatchObject({ code: 'RESERVATION_CONFLICT' });
  expect((await reservations.list(scope)).records.map(saved => saved.record.recordId)).toContain(recordId);
});
