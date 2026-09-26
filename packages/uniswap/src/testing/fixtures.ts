import type { Scope } from '../domain.js';
import type { StoreSeed } from './store.js';

export const fixtureOwner = `0x${'11'.repeat(20)}`;
export const fixtureOtherOwner = `0x${'22'.repeat(20)}`;
export const fixtureId = `0x${'33'.repeat(32)}`;
export const fixtureInputId = `0x${'44'.repeat(32)}`;
export const fixtureSecondId = `0x${'55'.repeat(32)}`;
export const fixtureScope = { deploymentId: 'local-v1', owner: fixtureOwner } as Scope;

const signature = `0x${'aa'.repeat(65)}`;
const bundle = { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` };
const payRecord = {
  recordId: fixtureId,
  kind: 'pay',
  inputId: fixtureInputId,
  operationId: fixtureId,
  paymentId: fixtureId,
  deadline: '600',
  contentHash: fixtureId,
  encryptedBundle: bundle,
  signatureStarted: false,
  attemptIds: [],
};
const withdrawRecord = {
  recordId: fixtureSecondId,
  kind: 'withdraw',
  inputId: fixtureInputId,
  operationId: fixtureSecondId,
  contentHash: fixtureSecondId,
  encryptedBundle: bundle,
  signatureStarted: false,
  attemptIds: [],
};
const reward = {
  scope: fixtureScope,
  requestId: fixtureId,
  amountWei: '1',
  recipientInfo: { owner: fixtureOwner, publicKey: fixtureInputId, signature },
};
const operationPath = `/v1/operations/${fixtureId}`;
const operationsQuery = `/v1/operations?deploymentId=local-v1&owner=${fixtureOwner}`;
const rewardQuery = `/v1/rewards?deploymentId=local-v1&owner=${fixtureOwner}`;

export type HttpStep =
  | { readonly kind: 'challenge' }
  | { readonly kind: 'verify'; readonly status: number; readonly code?: string }
  | { readonly kind: 'reject-auth'; readonly reason: 'wrong-domain' | 'wrong-chain' | 'wrong-owner' | 'invalid-signature' }
  | { readonly kind: 'clock'; readonly at: number }
  | { readonly kind: 'lose-ack'; readonly route: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rollback' }
  | { readonly kind: 'partial-rollback' }
  | { readonly kind: 'login-other' }
  | {
      readonly kind: 'request';
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
      readonly status?: number;
      readonly code?: string;
      readonly reject?: string;
      readonly recordId?: string;
      readonly recordsLength?: number;
      readonly requestId?: string;
    };

export interface HttpScenario {
  readonly id: string;
  readonly specIds: readonly string[];
  readonly seed: StoreSeed;
  readonly autoLogin: boolean;
  readonly steps: readonly HttpStep[];
  readonly expected: { readonly reservations: number; readonly requests: number; readonly receipts: number };
}

function scenario(id: string, steps: readonly HttpStep[], expected: HttpScenario['expected'], autoLogin = true, specIds: readonly string[] = []): HttpScenario {
  return { id, specIds, seed: {}, autoLogin, steps, expected };
}

const none = { reservations: 0, requests: 0, receipts: 0 };

export const httpScenarios: readonly HttpScenario[] = [
  ...(['wrong-domain', 'wrong-chain', 'wrong-owner', 'invalid-signature'] as const).map((reason) =>
    scenario(`challenge/${reason}`, [
      { kind: 'challenge' }, { kind: 'reject-auth', reason },
      { kind: 'verify', status: 401, code: 'UNAUTHENTICATED' },
    ], none, false)),
  scenario('challenge/reuse', [
    { kind: 'challenge' }, { kind: 'verify', status: 200 },
    { kind: 'verify', status: 401, code: 'CHALLENGE_USED' },
  ], none, false),
  scenario('challenge/expiry', [
    { kind: 'challenge' }, { kind: 'clock', at: 300001 },
    { kind: 'verify', status: 401, code: 'CHALLENGE_EXPIRED' },
  ], none, false),
  scenario('session/expiry', [
    { kind: 'clock', at: 1800001 },
    { kind: 'request', method: 'GET', path: operationsQuery, status: 401, code: 'UNAUTHENTICATED' },
  ], none),
  scenario('operation/ack-lost', [
    { kind: 'lose-ack', route: 'PUT /v1/operations/{id}' },
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: payRecord }, reject: 'ACK_LOST' },
    { kind: 'request', method: 'GET', path: operationsQuery, status: 200, recordId: fixtureId },
  ], { ...none, reservations: 1 }, true, ['S-27']),
  scenario('operation/revision-conflict', [
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: payRecord }, status: 200 },
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: { ...payRecord, signatureStarted: true } }, status: 409, code: 'REVISION_CONFLICT' },
  ], { ...none, reservations: 1 }),
  scenario('operation/pay-withdraw-conflict', [
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: payRecord }, status: 200 },
    { kind: 'request', method: 'PUT', path: `/v1/operations/${fixtureSecondId}`, body: { scope: fixtureScope, expectedRevision: 0, record: withdrawRecord }, status: 409, code: 'RESERVATION_CONFLICT' },
  ], { ...none, reservations: 1 }, true, ['S-26']),
  scenario('reward/ack-lost', [
    { kind: 'lose-ack', route: 'POST /v1/rewards' },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, reject: 'ACK_LOST' },
    { kind: 'request', method: 'GET', path: rewardQuery, status: 200, requestId: fixtureId },
  ], { ...none, requests: 1 }, true, ['S-42']),
  scenario('reward/duplicate-id', [
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 200 },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 200 },
  ], { ...none, requests: 1 }, true, ['S-41', 'S-43']),
  scenario('reward/pending-other-id', [
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 200 },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: { ...reward, requestId: fixtureSecondId }, status: 409, code: 'PENDING_REQUEST' },
  ], { ...none, requests: 1 }, true, ['S-41']),
  scenario('reward/content-conflict', [
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 200 },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: { ...reward, amountWei: '2' }, status: 409, code: 'REQUEST_CONFLICT' },
  ], { ...none, requests: 1 }, true, ['S-46']),
  scenario('reward/owner-isolation', [
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 200 },
    { kind: 'login-other' },
    { kind: 'request', method: 'GET', path: `/v1/rewards/${fixtureId}?deploymentId=local-v1&owner=${fixtureOtherOwner}`, status: 404, code: 'NOT_FOUND' },
  ], { ...none, requests: 1 }, true, ['S-47']),
  scenario('storage/unavailable', [
    { kind: 'unavailable' },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 503, code: 'SERVICE_UNAVAILABLE' },
  ], none),
  scenario('storage/rollback', [
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: payRecord }, status: 200 },
    { kind: 'rollback' },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 503, code: 'SERVICE_UNAVAILABLE' },
    { kind: 'request', method: 'GET', path: operationsQuery, status: 200, recordId: fixtureId },
  ], { ...none, reservations: 1 }),
  scenario('storage/partial-rollback', [
    { kind: 'request', method: 'PUT', path: operationPath, body: { scope: fixtureScope, expectedRevision: 0, record: payRecord }, status: 200 },
    { kind: 'partial-rollback' },
    { kind: 'request', method: 'GET', path: operationsQuery, status: 200, recordsLength: 0 },
    { kind: 'request', method: 'POST', path: '/v1/rewards', body: reward, status: 503, code: 'SERVICE_UNAVAILABLE' },
  ], { ...none, reservations: 1 }),
];
