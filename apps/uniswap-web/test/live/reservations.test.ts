import { expect, it, vi } from 'vitest';
import { parseOperationRecord, type Scope } from '@confidential-utxo/uniswap';
import { createHttpClient } from '../../src/live/http.js';
import { createReservationPort } from '../../src/live/reservations.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'22'.repeat(32)}`;
const wire = { kind: 'pay', recordId: id, inputId: id, operationId: id, paymentId: id,
  contentHash: id, deadline: '600', signatureStarted: false, attemptIds: [],
  encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'01'.repeat(12)}`, tag: `0x${'02'.repeat(16)}` } };
const record = parseOperationRecord(wire, scope);
const saved = { scope, record: wire, revision: 1, status: 'reserved', stateVersion: 1 };
function setup(response: unknown = saved) {
  const transport = vi.fn(async () => Response.json(response));
  return { transport, port: createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport })) };
}
it('binds PUT to the sealed revision and preserves rich ACK metadata', async () => {
  const transport = vi.fn(async (request: Request) => {
    expect(await request.json()).toEqual({ scope, expectedRevision: 0, sealedRevision: 1, record: wire });
    return Response.json(saved);
  });
  const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport }));
  expect(await port.reserve(record, 0, 1)).toMatchObject({ revision: 1, status: 'reserved', stateVersion: 1, reservationState: 'active' });
});
it.each([[0, 2], [1, 1], [-1, 0], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]])('rejects unbound revision %s/%s before writing', async (expected, sealed) => {
  const { port, transport } = setup();
  await expect(port.update(record, expected, sealed)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it.each(['unknown', 'consumed', 'finalized-success', undefined])('never makes %s lifecycle actionable', async status => {
  const { port } = setup({ ...saved, status, stateVersion: status === undefined ? undefined : 2,
    ...(status === 'consumed' || status === 'finalized-success' ? { checkpoint: { blockNumber: '3', blockHash: id, blockTimestamp: '700' } } : {}) });
  await expect(port.get(scope, record.recordId)).rejects.toThrow();
});
it('preserves released checkpoint metadata without active status', async () => {
  const checkpoint = { blockNumber: '3', blockHash: id, blockTimestamp: '700' };
  const { port } = setup({ ...saved, status: 'released', stateVersion: 9, checkpoint });
  expect(await port.get(scope, record.recordId)).toMatchObject({ status: 'released', stateVersion: 9, checkpoint, reservationState: 'released' });
});
it.each([
  { revision: 2 }, { status: 'released' }, { reservationState: 'released' },
  ...['recordId', 'inputId', 'operationId', 'paymentId', 'contentHash'].map(field => ({ record: { ...wire, [field]: `0x${'99'.repeat(32)}` } })),
  { record: { ...wire, deadline: '601' } }, { record: { ...wire, signatureStarted: true } },
  { record: { ...wire, attemptIds: ['attempt-1'] } },
  ...['nonce', 'tag', 'ciphertext'].map(field => ({ record: { ...wire, encryptedBundle: { ...wire.encryptedBundle,
    [field]: field === 'ciphertext' ? 'BAUG' : `0x${'09'.repeat(field === 'nonce' ? 12 : 16)}` } } })),
])('rejects changed ACK %j', async changed => {
  await expect(setup({ ...saved, ...changed }).port.reserve(record, 0, 1)).rejects.toThrow();
});
it('returns undefined only for NOT_FOUND and does not hide service failure', async () => {
  for (const [code, status] of [['NOT_FOUND', 404], ['SERVICE_UNAVAILABLE', 503]] as const) {
    const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport: async () =>
      Response.json({ error: { code, message: code, allowedActions: [] } }, { status }) }));
    if (status === 404) expect(await port.get(scope, record.recordId)).toBeUndefined();
    else await expect(port.get(scope, record.recordId)).rejects.toThrow();
  }
});
it('lists every page and rejects rollback, unknown records and invalid pagination', async () => {
  const secondId = `0x${'33'.repeat(32)}`;
  for (const fault of ['none', 'rollback', 'unknown', 'duplicate', 'cursor', 'empty'] as const) {
    let calls = 0;
    const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport: async request => {
      calls++;
      if (calls === 1) return Response.json({ availability: 'healthy', records: [saved], nextCursor: id });
      expect(new URL(request.url).searchParams.get('cursor')).toBe(id);
      return Response.json({ availability: fault === 'rollback' ? 'rollback' : 'healthy',
        records: fault === 'empty' ? [] : [{ ...saved, status: fault === 'unknown' ? 'unknown' : 'reserved',
          record: { ...wire, recordId: fault === 'duplicate' ? id : secondId } }],
        ...(fault === 'cursor' ? { nextCursor: id } : {}) });
    } }));
    if (fault === 'none') expect((await port.list(scope)).records).toHaveLength(2);
    else if (fault === 'rollback') expect(await port.list(scope)).toEqual({ availability: 'rollback', records: [] });
    else await expect(port.list(scope)).rejects.toThrow();
    expect(calls).toBe(2);
  }
});
it('fails closed on release 503 without substituting PUT or manufacturing release', async () => {
  const transport = vi.fn(async (request: Request) => {
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(`/v1/operations/${id}/release`);
    expect(await request.json()).toEqual({ scope, expectedRevision: 1, sealedRevision: 2, record: wire, blockHash: id });
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable', allowedActions: [] } }, { status: 503 });
  });
  const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport }));
  await expect(port.release(record, { blockHash: record.recordId }, 1, 2)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('requires rich GET confirmation after a release ACK', async () => {
  for (const status of ['released', 'reserved', undefined]) {
    const transport = vi.fn(async (request: Request) => Response.json(request.method === 'POST'
      ? { scope, record: wire, revision: 2, reservationState: 'released' }
      : { ...saved, revision: 2, status, stateVersion: status ? 4 : undefined,
        ...(status === 'released' ? { checkpoint: { blockNumber: '3', blockHash: id, blockTimestamp: '700' } } : {}) }));
    const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport }));
    const result = port.release(record, { blockHash: record.recordId }, 1, 2);
    if (status === 'released') expect(await result).toMatchObject({ status, revision: 2, stateVersion: 4 });
    else await expect(result).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  }
});

it.each([undefined, 0])('requires positive rich stateVersion: %s', async stateVersion => {
  await expect(setup({ ...saved, stateVersion }).port.get(scope, record.recordId)).rejects.toThrow();
});
it('does not return until the server ACK has arrived', async () => {
  let respond!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { respond = resolve; });
  const port = createReservationPort(createHttpClient({ origin: 'https://mock.invalid', transport: async () => response }));
  let settled = false;
  const pending = port.reserve(record, 0, 1).then(value => { settled = true; return value; });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  respond(Response.json(saved));
  expect(await pending).toMatchObject({ revision: 1, reservationState: 'active' });
});
