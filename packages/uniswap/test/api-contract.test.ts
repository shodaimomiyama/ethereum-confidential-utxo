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
    ['PUT /v1/operations/{id}', { scope, record: payRecord, revision: 1 }],
    ['GET /v1/operations', { records: [{ scope, record: payRecord, revision: 1 }] }],
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

it('rejects response codes that disagree with conflict or unavailable status', () => {
  const error = { error: { code: 'REQUEST_CONFLICT', message: 'Request conflicts', allowedActions: ['recheck'] } };
  expect(() => parseApiResponse('POST /v1/rewards', 503, error)).toThrowError();
  expect(() => parseApiResponse('POST /v1/rewards', 409, error)).not.toThrow();
});
