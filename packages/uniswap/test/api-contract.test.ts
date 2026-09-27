import { expect, it } from 'vitest';
import { parseApiRequest, parseApiResponse } from '../src/api.js';

const owner = `0x${'11'.repeat(20)}`;
const other = `0x${'22'.repeat(20)}`;
const id = `0x${'33'.repeat(32)}`;
const hash = `0x${'44'.repeat(32)}`;
const scope = { deploymentId: 'local-v1', owner };
const payRecord = {
  recordId: id,
  kind: 'pay',
  inputId: hash,
  operationId: id,
  paymentId: hash,
  deadline: '600',
  contentHash: hash,
  encryptedBundle: {
    ciphertext: 'AQID',
    nonce: `0x${'00'.repeat(12)}`,
    tag: `0x${'00'.repeat(16)}`,
  },
  signatureStarted: false,
  attemptIds: [],
};
const reward = {
  scope,
  requestId: id,
  amountWei: '1',
  recipientInfo: { owner, publicKey: hash, signature: `0x${'aa'.repeat(65)}` },
};

it.each([
  ['POST', '/v1/auth/challenge', { scope }],
  ['POST', '/v1/auth/verify', { scope, challengeId: id, siweMessage: 'signed challenge', signature: `0x${'aa'.repeat(65)}` }],
  ['PUT', `/v1/operations/${id}`, { scope, expectedRevision: 0, record: payRecord }],
  ['GET', `/v1/operations?deploymentId=local-v1&owner=${owner}`, undefined],
  ['POST', '/v1/rewards', reward],
  ['GET', `/v1/rewards?deploymentId=local-v1&owner=${owner}`, undefined],
  ['GET', `/v1/rewards/${id}?deploymentId=local-v1&owner=${owner}`, undefined],
  ['POST', `/v1/rewards/${id}/received`, { scope, outputId: hash, blockHash: hash }],
] as const)('parses %s %s through its route schema', (method, path, body) => {
  expect(parseApiRequest(method, path, body).route).toBeDefined();
});

it('rejects invalid input on every route', () => {
  const invalid = [
    ['POST', '/v1/auth/challenge', { scope: { ...scope, owner: 'wrong' } }],
    ['POST', '/v1/auth/verify', { scope, challengeId: 'wrong', siweMessage: 'x', signature: '0xaa' }],
    ['PUT', `/v1/operations/${id}`, { scope, expectedRevision: -1, record: payRecord }],
    ['GET', '/v1/operations?deploymentId=&owner=wrong', undefined],
    ['POST', '/v1/rewards', { ...reward, amountWei: '1e3' }],
    ['GET', '/v1/rewards?deploymentId=&owner=wrong', undefined],
    ['GET', `/v1/rewards/${id}?deploymentId=&owner=wrong`, undefined],
    ['POST', `/v1/rewards/${id}/received`, { scope, outputId: 'wrong', blockHash: hash }],
  ] as const;
  for (const [method, path, body] of invalid) {
    expect(() => parseApiRequest(method, path, body)).toThrowError();
  }
});

it('rejects reward recipient mismatch and non-positive amount', () => {
  expect(() => parseApiRequest('POST', '/v1/rewards', { ...reward, amountWei: '0' })).toThrowError();
  expect(() => parseApiRequest('POST', '/v1/rewards', {
    ...reward,
    recipientInfo: { ...reward.recipientInfo, owner: other },
  })).toThrowError();
});

it('keeps Pay deadline distinct from Withdraw without a deadline', () => {
  expect(() => parseApiRequest('PUT', `/v1/operations/${id}`, {
    scope,
    expectedRevision: 0,
    record: { ...payRecord, kind: 'withdraw', paymentId: undefined, deadline: undefined },
  })).not.toThrow();
  expect(() => parseApiRequest('PUT', `/v1/operations/${id}`, {
    scope,
    expectedRevision: 0,
    record: { ...payRecord, kind: 'withdraw' },
  })).toThrowError();
});

it('parses machine-readable error responses without reflecting secret fields', () => {
  const parsed = parseApiResponse('POST /v1/rewards', 409, {
    error: { code: 'REQUEST_CONFLICT', message: 'Request conflicts', allowedActions: ['recheck'] },
  });
  expect(parsed).toEqual({ error: { code: 'REQUEST_CONFLICT', message: 'Request conflicts', allowedActions: ['recheck'] } });
  expect(() => parseApiResponse('POST /v1/rewards', 503, { error: { code: 'BAD', message: reward.recipientInfo.signature, allowedActions: [] } })).toThrowError();
});

it('validates success response shape for every route', () => {
  const rewardRecord = { ...reward, status: 'accepted', attemptIds: [], txHashes: [] };
  const valid = [
    ['POST /v1/auth/challenge', { challengeId: id, nonce: hash, issuedAt: 0, expiresAt: 300000 }],
    ['POST /v1/auth/verify', { sessionExpiresAt: 1800000 }],
    ['PUT /v1/operations/{id}', { scope, record: payRecord, revision: 1, stateVersion: 1, status: 'reserved' }],
    ['GET /v1/operations', { availability: 'healthy', records: [{ scope, record: payRecord, revision: 1, stateVersion: 1, status: 'reserved' }] }],
    ['POST /v1/rewards', { reward: rewardRecord }],
    ['GET /v1/rewards', { rewards: [rewardRecord] }],
    ['GET /v1/rewards/{id}', { reward: rewardRecord }],
    ['POST /v1/rewards/{id}/received', { reward: { ...rewardRecord, status: 'received', outputId: id, blockHash: hash } }],
  ] as const;
  for (const [route, body] of valid) {
    expect(parseApiResponse(route, 200, body)).toBeDefined();
    expect(() => parseApiResponse(route, 200, {})).toThrowError();
  }
});

it('preserves reward availability and checked block while rejecting unknown reasons', () => {
  const record = {
    ...reward,
    status: 'queued',
    availability: 'funds-short',
    checkedAtBlockHash: hash,
    attemptIds: [],
    txHashes: [],
  };
  expect(parseApiResponse('POST /v1/rewards', 200, { reward: record })).toMatchObject({
    reward: { status: 'queued', availability: 'funds-short', checkedAtBlockHash: hash },
  });
  expect(() => parseApiResponse('POST /v1/rewards', 200, {
    reward: { ...record, availability: 'unrecognized' },
  })).toThrowError();
  expect(() => parseApiResponse('POST /v1/rewards', 200, {
    reward: { ...record, checkedAtBlockHash: '0x12' },
  })).toThrowError();
});

it('rejects response codes that disagree with conflict or unavailable status', () => {
  const error = { error: { code: 'REQUEST_CONFLICT', message: 'Request conflicts', allowedActions: ['recheck'] } };
  expect(() => parseApiResponse('POST /v1/rewards', 503, error)).toThrowError();
  expect(() => parseApiResponse('POST /v1/rewards', 409, error)).not.toThrow();
});

it('parses reservation lookup and revision-bound release without trusting caller success flags', () => {
  const lookup = parseApiRequest('GET', `/v1/operations/${id}?deploymentId=local-v1&owner=${owner}`, undefined);
  expect(lookup.route).toBe('GET /v1/operations/{id}');
  expect(lookup.id).toBe(id);

  const release = parseApiRequest('POST', `/v1/operations/${id}/release`, {
    scope, expectedRevision: 1, sealedRevision: 2, blockHash: hash,
    record: { ...payRecord, encryptedBundle: { ...payRecord.encryptedBundle, nonce: `0x${'01'.repeat(12)}` } },
  });
  expect(release.route).toBe('POST /v1/operations/{id}/release');
  expect(release.sealedRevision).toBe(2);
  expect(() => parseApiRequest('POST', `/v1/operations/${id}/release`, {
    scope, expectedRevision: 1, sealedRevision: 2, blockHash: hash,
    paymentSucceeded: false, inputUnspent: true, record: payRecord,
  })).toThrowError();
  expect(() => parseApiRequest('POST', `/v1/operations/${id}/release`, {
    scope, expectedRevision: 1, sealedRevision: 3, blockHash: hash, record: payRecord,
  })).toThrowError();
});

it('rejects a PUT whose sealed revision disagrees with its compare-and-swap target', () => {
  expect(() => parseApiRequest('PUT', `/v1/operations/${id}`, {
    scope, expectedRevision: 1, sealedRevision: 3, record: payRecord,
  })).toThrowError();
});

it('parses released records and rejects unknown reservation states', () => {
  const response = { scope, record: payRecord, revision: 2, reservationState: 'released' };
  expect(parseApiResponse('POST /v1/operations/{id}/release', 200, response)).toMatchObject({ reservationState: 'released', revision: 2 });
  expect(() => parseApiResponse('POST /v1/operations/{id}/release', 200, { ...response, reservationState: 'missing' })).toThrowError();
});

it.each([
  ['PUT', `/v1/operations/${id}`],
  ['POST', `/v1/operations/${id}/release`],
])('bounds the complete %s operation request to 1 MiB', (method, path) => {
  const body = { scope, expectedRevision: 1, sealedRevision: 2, blockHash: hash,
    record: { ...payRecord, encryptedBundle: { ...payRecord.encryptedBundle, ciphertext: '' } } };
  const overhead = new TextEncoder().encode(JSON.stringify(body)).length;
  body.record.encryptedBundle.ciphertext = 'A'.repeat(1_048_576 - overhead);
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBe(1_048_576);
  expect(() => parseApiRequest(method!, path!, body)).not.toThrow();
  body.record.encryptedBundle.ciphertext += 'A';
  expect(() => parseApiRequest(method!, path!, body)).toThrowError('INVALID_FIELD');
});

it('parses operation lifecycle separately from encrypted revision', () => {
  const parsed = parseApiResponse('GET /v1/operations', 200, {
    availability: 'healthy',
    records: [{
      scope,
      record: payRecord,
      revision: 1,
      stateVersion: 2,
      status: 'released',
      checkpoint: { blockNumber: '12', blockHash: id, blockTimestamp: '601' },
    }],
  });
  if ('error' in parsed) throw new Error('unexpected error response');
  expect(parsed.records[0]?.status).toBe('released');
  expect(parsed.records[0]?.revision).toBe(1);
  expect(parsed.records[0]?.stateVersion).toBe(2);
});

it('accepts a record ID cursor for the next operations page', () => {
  const request = parseApiRequest('GET', `/v1/operations?deploymentId=local-v1&owner=${owner}&cursor=${id}`, undefined);
  expect(request.cursor).toBe(id);
  const response = parseApiResponse('GET /v1/operations', 200, {
    availability: 'healthy', records: [], nextCursor: id,
  });
  if ('error' in response) throw new Error('unexpected error response');
  expect(response.nextCursor).toBe(id);
});

it.each([
  { status: 'reserved' },
  { stateVersion: 2 },
  { checkpoint: { blockNumber: '12', blockHash: id, blockTimestamp: '601' } },
  { status: 'released', stateVersion: 2 },
  { status: 'invalid', stateVersion: 2 },
  { status: undefined, stateVersion: undefined },
])('rejects incomplete service lifecycle fields without falling back to legacy: %j', (fields) => {
  const record = { scope, record: payRecord, revision: 1, ...fields };
  expect(() => parseApiResponse('PUT /v1/operations/{id}', 200, record)).toThrowError();
  expect(() => parseApiResponse('GET /v1/operations/{id}', 200, record)).toThrowError();
  expect(() => parseApiResponse('GET /v1/operations', 200, {
    availability: 'healthy', records: [record],
  })).toThrowError();
});

it('preserves complete service lifecycle and legacy reservation fields without inventing state', () => {
  const legacy = { scope, record: payRecord, revision: 3, reservationState: 'active' };
  const parsedLegacy = parseApiResponse('PUT /v1/operations/{id}', 200, legacy);
  expect(parsedLegacy).toMatchObject({ revision: 3, reservationState: 'active' });
  expect(parseApiResponse('GET /v1/operations/{id}', 200, legacy)).toEqual(parsedLegacy);
  expect(parsedLegacy).not.toHaveProperty('status');
  expect(parsedLegacy).not.toHaveProperty('stateVersion');
  const rich = {
    ...legacy, reservationState: 'released', status: 'released', stateVersion: 7,
    checkpoint: { blockNumber: '12', blockHash: id, blockTimestamp: '601' },
  };
  const parsed = parseApiResponse('PUT /v1/operations/{id}', 200, rich);
  expect(parsed).toMatchObject({
    revision: 3, status: 'released', stateVersion: 7,
    checkpoint: rich.checkpoint, reservationState: 'released',
  });
});
