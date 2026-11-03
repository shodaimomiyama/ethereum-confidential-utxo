import { expect, it } from 'vitest';
import { parseApiRequest, type Address, type Bytes32, type OperationRecord, type SavedOperation, type Scope } from '@confidential-utxo/uniswap';
import type { HttpClient } from '../../src/live/http.js';
import { createHttpClient } from '../../src/live/http.js';
import { encodeRecordAad, openRecord, saveBeforeAuthorization, sealRecord } from '../../src/live/record-crypto.js';

const id = (byte: string) => `0x${byte.repeat(64)}` as Bytes32;
const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const context = { deploymentId: scope.deploymentId, chainId: 31337n,
  pool: `0x${'22'.repeat(20)}` as Address, owner: scope.owner, recordId: id('3'), revision: 1 };
const plain = { version: 1 as const, creationInputs: { amountWei: 12n, count: 7, seed: new Uint8Array([1, 2]) },
  operationId: id('4'), paymentId: id('5'), intendedAuthorization: { maxWei: '12' },
  attempts: [], recoveryMarkers: { phase: 'reserved' } };
const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

it('round trips a versioned record with canonical decimal and hex values', async () => {
  const secret = await key();
  const bundle = await sealRecord(secret, context, plain);
  expect(await openRecord(secret, context, bundle)).toEqual({ ...plain,
    creationInputs: { amountWei: '12', count: '7', seed: '0x0102' } });
});

it.each([
  ['deploymentId', 'other'], ['chainId', 1n], ['pool', `0x${'33'.repeat(20)}`],
  ['owner', `0x${'44'.repeat(20)}`], ['recordId', id('6')], ['revision', 2],
] as const)('rejects changed AAD %s', async (field, value) => {
  const secret = await key();
  const bundle = await sealRecord(secret, context, plain);
  await expect(openRecord(secret, { ...context, [field]: value }, bundle)).rejects.toThrow();
});

it('rejects ciphertext, tag and key changes', async () => {
  const secret = await key();
  const bundle = await sealRecord(secret, context, plain);
  const changed = bundle.ciphertext[0] === 'A' ? 'B' : 'A';
  await expect(openRecord(secret, context, { ...bundle, ciphertext: changed + bundle.ciphertext.slice(1) })).rejects.toThrow();
  await expect(openRecord(secret, context, { ...bundle, tag: `0x${'ff'.repeat(16)}` })).rejects.toThrow();
  await expect(openRecord(await key(), context, bundle)).rejects.toThrow();
});

it('rejects unknown plaintext versions and payloads over 1 MiB', async () => {
  const secret = await key();
  await expect(sealRecord(secret, context, { ...plain, version: 2 as never })).rejects.toThrow();
  await expect(sealRecord(secret, context, { ...plain, creationInputs: { filler: 'x'.repeat(1_048_576) } })).rejects.toThrow();
  const iv = new Uint8Array(12);
  const raw = new TextEncoder().encode(JSON.stringify({ ...plain, version: 2, creationInputs: {} }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encodeRecordAad(context), tagLength: 128 }, secret, raw));
  const bundle = { nonce: `0x${'00'.repeat(12)}`, ciphertext: btoa(String.fromCharCode(...encrypted.slice(0, -16))),
    tag: `0x${Array.from(encrypted.slice(-16), byte => byte.toString(16).padStart(2, '0')).join('')}` };
  await expect(openRecord(secret, context, bundle)).rejects.toThrow();
});

it('uses a distinct injected nonce for each save', async () => {
  const secret = await key();
  let next = 1;
  const random = (bytes: Uint8Array) => { bytes.fill(next++); return bytes; };
  const first = await sealRecord(secret, context, plain, random);
  const second = await sealRecord(secret, context, plain, random);
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.ciphertext).not.toBe(second.ciphertext);
});

it('refuses reuse when a nonce source repeats for the same key', async () => {
  const secret = await key();
  const random = (bytes: Uint8Array) => { bytes.fill(9); return bytes; };
  await sealRecord(secret, context, plain, random);
  await expect(sealRecord(secret, context, plain, random)).rejects.toThrow();
});

function record(bundle: Awaited<ReturnType<typeof sealRecord>>): OperationRecord {
  return { kind: 'pay', recordId: context.recordId, scope, inputId: id('7') as never,
    operationId: plain.operationId as never, paymentId: plain.paymentId as never,
    contentHash: id('8'), deadline: 123n, encryptedBundle: bundle,
    signatureStarted: false, attemptIds: [] };
}

it('proves a lost PUT ACK by GET of the exact committed bundle without retrying PUT', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  const calls: string[] = [];
  const saved: SavedOperation = { record: original, revision: 1 };
  const http = { async call(route: string, input: { body?: unknown }) {
    calls.push(route);
    if (route === 'PUT /v1/operations/{id}') {
      expect(input.body).toMatchObject({ expectedRevision: 0, sealedRevision: 1,
        record: { encryptedBundle: original.encryptedBundle } });
      throw new Error('ACK disappeared');
    }
    return { ...saved, scope, reservationState: 'active' };
  } } as HttpClient;
  await expect(saveBeforeAuthorization(http, original, 0)).resolves.toEqual({ ...saved, scope, reservationState: 'active' });
  expect(calls).toEqual(['PUT /v1/operations/{id}', 'GET /v1/operations/{id}']);
});

it('uses the real HTTP schema after ACK loss without exposing plaintext in the request', async () => {
  const marker = 'SYNTHETIC_SECRET_DO_NOT_SEND';
  const original = record(await sealRecord(await key(), context,
    { ...plain, creationInputs: { marker } }));
  const putBodies: string[] = [];
  let committed: OperationRecord | undefined;
  const http = createHttpClient({ origin: 'https://mock.invalid', transport: async request => {
    if (request.method === 'PUT') {
      const body = await request.text();
      putBodies.push(body);
      const parsed = parseApiRequest('PUT', request.url, JSON.parse(body));
      committed = parsed.record;
      throw new TypeError('connection dropped after commit');
    }
    expect(request.method).toBe('GET');
    expect(committed).toBeDefined();
    const savedWire = { ...committed, deadline: '123' };
    expect(new URL(request.url).pathname).toBe(`/v1/operations/${original.recordId}`);
    return Response.json({ scope, record: savedWire, revision: 1, stateVersion: 7,
      status: 'reserved', reservationState: 'active' });
  } });
  const saved = await saveBeforeAuthorization(http, original, 0);
  expect(saved).toMatchObject({ revision: 1, stateVersion: 7, status: 'reserved' });
  expect(saved.record.encryptedBundle).toEqual(original.encryptedBundle);
  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]).not.toContain(marker);
});

it('blocks authorization when GET cannot prove the original bundle or revision', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  for (const returned of [
    { record: { ...original, encryptedBundle: { ...original.encryptedBundle, tag: `0x${'ff'.repeat(16)}` } }, revision: 1 },
    { record: { ...original, contentHash: id('9') }, revision: 1 },
    { record: original, revision: 2 },
  ]) {
    const http = { async call(route: string) {
      if (route === 'PUT /v1/operations/{id}') throw new Error('ACK disappeared');
      return { ...returned, scope };
    } } as HttpClient;
    await expect(saveBeforeAuthorization(http, original, 0)).rejects.toThrow();
  }
});

it('rejects a wire operation request larger than 1 MiB', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  const { scope: _scope, ...wire } = original;
  const body = { scope, expectedRevision: 0, record: { ...wire, deadline: '123',
    encryptedBundle: { ...wire.encryptedBundle, ciphertext: 'A'.repeat(1_048_576) } } };
  expect(() => parseApiRequest('PUT', `https://mock.invalid/v1/operations/${original.recordId}`, body)).toThrow();
});

it('rejects a conflicting ACK instead of treating it as a successful save', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  const http = { async call() { return { scope, record: original, revision: 3 }; } } as unknown as HttpClient;
  await expect(saveBeforeAuthorization(http, original, 0)).rejects.toThrow();
});

it('accepts a byte-identical idempotent ACK at its explicitly sealed existing revision', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  const saved: SavedOperation = { record: original, revision: 1 };
  const calls: string[] = [];
  const http = { async call(route: string) {
    calls.push(route);
    return { ...saved, scope, reservationState: 'active' };
  } } as HttpClient;
  await expect(saveBeforeAuthorization(http, original, 1, { bundleRevision: 1 })).resolves.toEqual({
    ...saved, scope, reservationState: 'active',
  });
  expect(calls).toEqual(['GET /v1/operations/{id}']);
  await expect(saveBeforeAuthorization(http, original, 1)).rejects.toThrow();
});

it('refuses to authorize an existing bundle whose reservation was released', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  const http = { async call(route: string) {
    expect(route).toBe('GET /v1/operations/{id}');
    return { scope, record: original, revision: 1, reservationState: 'released' };
  } } as HttpClient;
  await expect(saveBeforeAuthorization(http, original, 1, { bundleRevision: 1 }))
    .rejects.toThrow('OPERATION_SAVE_UNCONFIRMED');
});

it('accepts a byte-identical existing revision after lost ACK, without retrying or accepting changed metadata', async () => {
  const original = record(await sealRecord(await key(), context, plain));
  let returned: OperationRecord = original;
  const calls: string[] = [];
  const http = { async call(route: string) {
    calls.push(route);
    if (route === 'PUT /v1/operations/{id}') throw new Error('unexpected PUT');
    return { scope, record: returned, revision: 1, reservationState: 'active' };
  } } as HttpClient;
  await expect(saveBeforeAuthorization(http, original, 1, { bundleRevision: 1 }))
    .resolves.toEqual({ scope, record: original, revision: 1, reservationState: 'active' });
  expect(calls).toEqual(['GET /v1/operations/{id}']);
  returned = { ...original, contentHash: id('9') };
  await expect(saveBeforeAuthorization(http, original, 1, { bundleRevision: 1 })).rejects.toThrow();
  returned = { ...original, encryptedBundle: { ...original.encryptedBundle, nonce: `0x${'ff'.repeat(12)}` } };
  await expect(saveBeforeAuthorization(http, original, 1, { bundleRevision: 1 })).rejects.toThrow();
});

it.each([404, 503])('blocks authorization when lost-ACK lookup returns %s', async status => {
  const original = record(await sealRecord(await key(), context, plain));
  const calls: string[] = [];
  const http = createHttpClient({ origin: 'https://mock.invalid', transport: async request => {
    calls.push(request.method);
    if (request.method === 'PUT') throw new TypeError('ACK lost');
    const code = status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE';
    return Response.json({ error: { code, message: code, allowedActions: [] } }, { status });
  } });
  await expect(saveBeforeAuthorization(http, original, 0)).rejects.toMatchObject({ kind: 'api',
    code: status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE' });
  expect(calls).toEqual(['PUT', 'GET']);
});
