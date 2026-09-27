import { expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizationTypedData, buildOperation, recipientInfoTypedData, type Context } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import { paymentAuthorizationTypedData, paymentDigest, type Address, type PaymentTerms, type PreparedFullWithdraw, type Scope, type SavedReservation } from '@confidential-utxo/uniswap';
import { createMemoryReservationPort, createMockHttp, createMemoryStore, createManualClock } from '@confidential-utxo/uniswap/testing';
import { createHttpClient } from '../../src/live/http.js';
import { createReservationPort } from '../../src/live/reservations.js';
import { decodePaymentPrivateRecord, encodePaymentPrivateRecord, openPaymentPrivateRecord } from '../../src/live/payment-record.js';
import { createScopedPaymentClient, type ScopedPaymentDependencies } from '../../src/live/payment-ports.js';
import { paymentContentHash } from '../../src/live/payment-preparation.js';
import type { OperationContext } from '../../src/live/operations.js';
const hash = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const account = privateKeyToAccount(hash('1'));
const scope = { deploymentId: 'local', owner: account.address } as Scope;
const deployment = { chainId: 31337n, pool: `0x${'22'.repeat(20)}` as Address, adapter: `0x${'33'.repeat(20)}` } as const;
async function setup(options: { lostAck?: boolean; refuse?: boolean; driftAt?: string; pay?: boolean; refreshChange?: boolean; refreshTamperHash?: boolean } = {}) {
  const calls: string[] = [];
  let epoch = 0;
  let currentDeployment = deployment;
  const tick = (name: string) => { calls.push(name); if (options.driftAt === name) epoch += 2; };
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const context: OperationContext = { scope, epoch: 0, check: () => { if (epoch !== 0) throw new Error('SCOPE_CHANGED'); },
    recordKey: () => key, recipientInfo: () => { throw new Error('unused'); }, recipientPrivateKeyForWorker: () => { throw new Error('unused'); },
    runCrypto: async () => { throw new Error('unused'); }, sendTransaction: async () => { throw new Error('unused'); },
    typedSign: async (data, purpose) => { tick(purpose); if (options.refuse) throw new Error('USER_REFUSED');
      return { scope, epoch: 0, value: await account.signTypedData(data as Parameters<typeof account.signTypedData>[0]) }; },
  };
  const coreContext: Context = { chainId: deployment.chainId, pool: deployment.pool, verifier: deployment.pool, parametersHash: hash('1'), deploymentBlock: 0n, finalityMode: 'finalized' };
  const opening = { amount: 10n, blinding: 2n };
  const unsignedRecipient = { chainId: deployment.chainId, pool: deployment.pool, owner: account.address, receivePublicKey: hash('7'), receiptFormat: 1, recipientInfoVersion: 1 } as const;
  const recipient = { ...unsignedRecipient, signature: await account.signTypedData(recipientInfoTypedData(coreContext, unsignedRecipient, account.address)) };
  const draft = await buildOperation({ kind: 2, owner: account.address, amount: options.pay ? 9n : 10n, destination: options.pay ? deployment.adapter : account.address,
    ...(options.pay ? { changeRecipient: recipient } : {}) }, coreContext,
    { randomSalt: () => new Uint8Array(32).fill(4), inputs: [{ id: hash('2'), owner: account.address, opening, commitment: commit(opening),
      checkpoint: { number: 1n, hash: hash('3'), mode: 'finalized' }, status: 'available', chainId: deployment.chainId, pool: deployment.pool }] });
  const terms: PaymentTerms = { operationId: draft.operationId as never, owner: scope.owner, ethAmount: 9n, token: `0x${'44'.repeat(20)}` as Address, minAmountOut: 1n, recipient: `0x${'55'.repeat(20)}` as Address, deadline: 600n };
  const quote = { startedAtMs: 0, blockHash: hash('1') as never, blockNumber: 1n, inputWei: 9n, quoteOut: 99n };
  const contentHash = options.pay ? paymentContentHash(draft, terms, quote, deployment) : hash('5');
  const record = { kind: options.pay ? 'pay' : 'withdraw', ...(options.pay ? { paymentId: paymentDigest(terms, deployment.chainId, deployment.adapter as Address), deadline: terms.deadline } : {}), scope, recordId: hash('4'), inputId: hash('2'), operationId: draft.operationId, contentHash,
    encryptedBundle: { nonce: '', ciphertext: '', tag: '' }, signatureStarted: false, attemptIds: [] } as unknown as PreparedFullWithdraw['record'];
  const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = record;
  const poolAuthorization = authorizationTypedData(coreContext, draft.request);
  const prepared: PreparedFullWithdraw = { record, poolAuthorization,
    privateBytes: encodePaymentPrivateRecord({ version: 1, creationInputs: draft, binding, operationId: record.operationId,
      ...(options.pay ? { paymentId: paymentDigest(terms, deployment.chainId, deployment.adapter as Address) } : {}),
      intendedAuthorization: { pool: poolAuthorization, ...(options.pay ? { payment: paymentAuthorizationTypedData(terms, deployment.chainId, deployment.adapter as Address) } : {}) }, attempts: [], recoveryMarkers: {} }) };
  const store = createMemoryReservationPort();
  const mock = createMockHttp({ store: createMemoryStore(), clock: createManualClock(0), reservations: store });
  const post = (path: string, body: unknown) => mock.fetch(new Request(`https://mock.invalid${path}`, { method: 'POST', body: JSON.stringify(body) }));
  const challenge = await (await post('/v1/auth/challenge', { scope })).json() as { challengeId: string };
  const login = await post('/v1/auth/verify', { scope, challengeId: challenge.challengeId, siweMessage: 'synthetic SIWE', signature: `0x${'aa'.repeat(65)}` });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const revisions: SavedReservation[] = [];
  let loseAck = options.lostAck;
  const reservations = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport: async request => {
    const headers = new Headers(request.headers); headers.set('cookie', cookie);
    const response = await mock.fetch(new Request(request, { headers }));
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) return Response.json(body, { status: response.status });
    if (request.method === 'PUT') { revisions.push(structuredClone((await store.get(scope, record.recordId))!)); tick(`ack:${body.revision}`);
      if (loseAck) { loseAck = false; throw new Error('LOST_ACK'); } }
    if (request.method === 'GET') tick(`get:${new URL(request.url).pathname.split('/').at(-1)}`);
    if (Array.isArray(body.records)) return Response.json({ ...body, records: body.records.map(item => ({ ...item, status: 'reserved', stateVersion: item.revision })) });
    return Response.json({ ...body, status: 'reserved', stateVersion: body.revision });
  } }));
  let attempt = 0;
  const dependencies: ScopedPaymentDependencies = { context, resolveDeployment: () => currentDeployment, reservations,
    preparePay: async () => ({ ...prepared, quote }), prepareFullWithdraw: async () => prepared,
    refreshPay: async value => {
      if (!options.refreshChange && !options.refreshTamperHash) return value;
      const nextTerms = { ...terms, minAmountOut: 2n };
      const nextQuote = { ...quote, startedAtMs: 40_000, quoteOut: 101n };
      const nextRecord = { ...record, paymentId: paymentDigest(nextTerms, deployment.chainId, deployment.adapter as Address),
        contentHash: options.refreshTamperHash ? hash('f') as never : paymentContentHash(draft, nextTerms, nextQuote, deployment) };
      const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = nextRecord;
      const plain = decodePaymentPrivateRecord(prepared.privateBytes);
      return { record: nextRecord, quote: nextQuote, poolAuthorization,
        privateBytes: encodePaymentPrivateRecord({ ...plain, binding: binding as never, paymentId: nextRecord.paymentId,
          intendedAuthorization: { pool: poolAuthorization,
            payment: paymentAuthorizationTypedData(nextTerms, deployment.chainId, deployment.adapter as Address) } }) } as unknown as typeof value;
    }, validatePrepared: async () => {}, paymentTerms: value => value.record.kind === 'pay' && value.record.paymentId !== record.paymentId
      ? { ...terms, minAmountOut: 2n } : terms,
    clock: { now: () => options.refreshChange || options.refreshTamperHash ? 40_000 : 0 }, latestBlockTime: async () => 100n,
    createAttempt: () => `attempt-${++attempt}` as never,
    submit: async () => { tick('submit'); return { kind: 'submitted', txHash: hash('6') as never }; },
  };
  const client = createScopedPaymentClient(dependencies);
  return { dependencies, client, prepared, record, key, calls, store, revisions, context, changeManifest: () => { currentDeployment = { ...deployment, adapter: account.address } as typeof deployment; } };
}
it.each([false, true])('binds actual AES revisions and #55 ACK ordering, lost ACK=%s', async lostAck => {
  const f = await setup({ lostAck });
  const prepared = await f.client.prepareFullWithdraw({});
  await f.client.authorizeFullWithdraw(prepared, f.record.contentHash);
  expect(f.calls).toEqual(['ack:1', ...(lostAck ? [`get:${f.record.recordId}`] : []), 'ack:2', 'pool-authorization', 'ack:3', 'ack:4', 'submit', 'ack:5']);
  for (const saved of f.revisions) {
    const aad = { ...deployment, ...scope, recordId: f.record.recordId, revision: saved.revision };
    const plain = await openPaymentPrivateRecord(f.key, aad, saved.record);
    expect(plain.signatures !== undefined).toBe(saved.revision >= 3);
    expect(plain.attempts).toEqual(saved.revision >= 4 ? [{ attemptId: 'attempt-1', ...(saved.revision === 5 ? { txHash: hash('6') } : {}) }] : []);
    await expect(openPaymentPrivateRecord(f.key, { ...aad, revision: saved.revision + 1 }, saved.record)).rejects.toThrow();
  }
});
it('preserves the reservation after wallet refusal', async () => {
  const f = await setup({ refuse: true });
  await expect(f.client.authorizeFullWithdraw(await f.client.prepareFullWithdraw({}), f.record.contentHash)).rejects.toThrow('USER_REFUSED');
  expect(await f.store.get(scope, f.record.recordId)).toMatchObject({ revision: 2, reservationState: 'active' });
  expect(f.calls).not.toContain('submit');
});
it.each(['ack:2', 'pool-authorization', 'ack:4'])('blocks A → B → A stale work at %s', async driftAt => {
  const f = await setup({ driftAt });
  await expect(f.client.authorizeFullWithdraw(await f.client.prepareFullWithdraw({}), f.record.contentHash)).rejects.toThrow('SCOPE_CHANGED');
  expect(f.calls).not.toContain('submit');
  if (driftAt === 'ack:2') expect(f.calls).not.toContain('pool-authorization');
});
it('rejects manifest adapter drift and public/private mismatch before reservation', async () => {
  const f = await setup();
  const prepared = await f.client.prepareFullWithdraw({});
  await expect(f.client.authorizeFullWithdraw({ ...prepared, record: { ...prepared.record, contentHash: hash('9') as never } }, hash('9') as never)).rejects.toThrow();
  f.changeManifest();
  await expect(f.client.prepareFullWithdraw({})).rejects.toThrow('SCOPE_CHANGED');
  expect(f.calls).toEqual([]);
});

it('signs the published payment payload after Pool and retains both signatures in every subsequent revision', async () => {
  const f = await setup({ pay: true });
  const prepared = await f.client.preparePay({});
  await f.client.authorizePay(prepared, f.record.contentHash);
  expect(f.calls).toEqual(['ack:1', 'ack:2', 'pool-authorization', 'payment-authorization', 'ack:3', 'ack:4', 'submit', 'ack:5']);
  for (const saved of f.revisions.slice(2)) {
    const plain = await openPaymentPrivateRecord(f.key, { ...deployment, ...scope, recordId: f.record.recordId, revision: saved.revision }, saved.record);
    expect(plain.signatures?.pool).toMatch(/^0x[0-9a-f]{130}$/);
    expect(plain.signatures?.payment).toMatch(/^0x[0-9a-f]{130}$/);
    expect(plain.attempts.length).toBe(saved.revision >= 4 ? 1 : 0);
  }
});
it('reseeds authenticated restored bytes and preserves earlier signatures, attempts and hashes during #55 retry', async () => {
  const f = await setup();
  await f.client.authorizeFullWithdraw(await f.client.prepareFullWithdraw({}), f.record.contentHash);
  const recovery: NonNullable<ScopedPaymentDependencies['recovery']> = {
    readEvidence: async saved => ({ evidence: { finalized: true, blockTime: 100n, paymentSucceeded: false, submissionKnownAbsent: false,
      attempts: saved.record.attemptIds.map(id => ({ id, outcome: 'finalized-failure' as const })), storageAvailability: 'healthy' }, currentInput: { state: 'unspent' } }),
    restoreForRetry: async saved => {
      const plain = await openPaymentPrivateRecord(f.key, { ...deployment, ...scope, recordId: saved.record.recordId, revision: saved.revision }, saved.record);
      return { prepared: { ...f.prepared, record: saved.record, privateBytes: encodePaymentPrivateRecord(plain) }, signatures: plain.signatures! };
    },
    restoreOriginal: async () => { throw new Error('unused'); }, releaseOriginal: async () => { throw new Error('unused'); },
  };
  const restored = createScopedPaymentClient({ ...f.dependencies, recovery });
  await restored.retryAttempt(f.record.recordId);
  const saved = (await f.store.get(scope, f.record.recordId))!;
  expect(saved.revision).toBe(7);
  const plain = await openPaymentPrivateRecord(f.key, { ...deployment, ...scope, recordId: f.record.recordId, revision: 7 }, saved.record);
  expect(plain.attempts).toEqual([{ attemptId: 'attempt-1', txHash: hash('6') }, { attemptId: 'attempt-2', txHash: hash('6') }]);
  expect(f.calls.filter(call => call === 'pool-authorization')).toHaveLength(1);
  await expect(createScopedPaymentClient({ ...f.dependencies, recovery: { ...recovery,
    restoreForRetry: async (saved, evidence) => ({ ...await recovery.restoreForRetry(saved, evidence), prepared: f.prepared }) } }).retryAttempt(f.record.recordId)).rejects.toThrow();
});

it.each(['scope', 'epoch', 'owner', 'digest'] as const)('rejects a wallet reply with the wrong %s before submission', async wrong => {
  const f = await setup();
  const original = f.context.typedSign;
  const context: OperationContext = { ...f.context, typedSign: async (data, purpose) => {
    const result = await original(data, purpose);
    if (wrong === 'scope') return { ...result, scope: { ...scope, deploymentId: 'other' as never } };
    if (wrong === 'epoch') return { ...result, epoch: 2 };
    if (wrong === 'owner') return { ...result, value: await privateKeyToAccount(hash('2')).signTypedData(data as Parameters<typeof account.signTypedData>[0]) };
    const altered = structuredClone(data) as ReturnType<typeof authorizationTypedData>;
    return { ...result, value: await account.signTypedData({ ...altered, message: { ...altered.message, operationId: hash('9') } }) };
  } };
  const client = createScopedPaymentClient({ ...f.dependencies, context });
  await expect(client.authorizeFullWithdraw(await client.prepareFullWithdraw({}), f.record.contentHash)).rejects.toThrow();
  expect(f.calls).not.toContain('submit');
  expect((await f.store.get(scope, f.record.recordId))?.revision).toBe(2);
});
it('blocks an epoch change while the payment signature is outstanding', async () => {
  const f = await setup({ pay: true, driftAt: 'payment-authorization' });
  await expect(f.client.authorizePay(await f.client.preparePay({}), f.record.contentHash)).rejects.toThrow('SCOPE_CHANGED');
  expect(f.calls).not.toContain('submit');
  expect((await f.store.get(scope, f.record.recordId))?.revision).toBe(2);
});
it('does not replace newer in-memory history with a valid older restored ciphertext', async () => {
  const f = await setup();
  let rollback = false;
  const original = f.dependencies.reservations;
  const old = () => f.revisions.find(saved => saved.revision === 3)!;
  const recovery: NonNullable<ScopedPaymentDependencies['recovery']> = {
    readEvidence: async () => ({ evidence: { finalized: true, blockTime: 100n, paymentSucceeded: false, submissionKnownAbsent: true,
      attempts: [], storageAvailability: 'healthy' }, currentInput: { state: 'unspent' } }),
    restoreOriginal: async saved => {
      const plain = await openPaymentPrivateRecord(f.key, { ...deployment, ...scope, recordId: saved.record.recordId, revision: saved.revision }, saved.record);
      return { prepared: { ...f.prepared, record: saved.record as PreparedFullWithdraw['record'], privateBytes: encodePaymentPrivateRecord(plain) }, signatures: plain.signatures! };
    },
    restoreForRetry: async () => { throw new Error('unused'); }, releaseOriginal: async () => { throw new Error('unused'); },
  };
  const client = createScopedPaymentClient({ ...f.dependencies, recovery, reservations: { ...original,
    get: (...args) => rollback ? Promise.resolve(old()) : original.get(...args),
    list: (...args) => rollback ? Promise.resolve({ availability: 'healthy', records: [old()] }) : original.list(...args),
  } });
  await client.authorizeFullWithdraw(await client.prepareFullWithdraw({}), f.record.contentHash);
  rollback = true;
  await expect(client.resumeOriginal(f.record.recordId)).rejects.toThrow('INVALID_PAYMENT_BINDING');
  expect(f.calls.filter(call => call === 'submit')).toHaveLength(1);
});

it('lets #55 report changed fixed terms before reservation or signatures', async () => {
  const f = await setup({ pay: true, refreshChange: true });
  const initial = await f.client.preparePay({});
  await expect(f.client.authorizePay(initial, initial.record.contentHash)).rejects.toThrow('TERMS_CHANGED');
  expect(f.calls).toEqual([]);
  expect(await f.store.get(scope, initial.record.recordId)).toBeUndefined();
});
it('rejects refreshed terms whose display hash was supplied arbitrarily', async () => {
  const f = await setup({ pay: true, refreshTamperHash: true });
  const initial = await f.client.preparePay({});
  await expect(f.client.authorizePay(initial, initial.record.contentHash)).rejects.toThrow('INVALID_PAYMENT_BINDING');
  expect(f.calls).toEqual([]);
  expect(await f.store.get(scope, initial.record.recordId)).toBeUndefined();
});
