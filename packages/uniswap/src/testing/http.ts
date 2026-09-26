import type { ApiError, ApiRoute, ApiTransport, ParsedApiRequest } from '../api.js';
import { parseApiRequest, parseApiResponse } from '../api.js';
import type { Bytes32, Scope } from '../domain.js';
import { SchemaError } from '../schema.js';
import { StoreError } from '../storage.js';
import type { ManualClock } from './clock.js';
import type { MemoryStore } from './store.js';

interface Challenge {
  readonly scope: Scope;
  readonly expiresAt: number;
  used: boolean;
}

interface Session {
  readonly scope: Scope;
  readonly expiresAt: number;
}

export interface MockHttpControl {
  reset(): void;
}

export interface MockHttp {
  readonly fetch: ApiTransport;
  readonly control: MockHttpControl;
}

function scopeEqual(a: Scope, b: Scope): boolean {
  return a.deploymentId === b.deploymentId
    && a.owner.toLowerCase() === b.owner.toLowerCase();
}

function bytes32(counter: number): Bytes32 {
  return `0x${counter.toString(16).padStart(64, '0')}` as Bytes32;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}

function apiError(status: number, code: ApiError['code'], allowedActions: readonly string[] = []): Response {
  const error: ApiError = { code, message: code, allowedActions };
  return new Response(jsonBody({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mapFailure(error: unknown, route?: ApiRoute): Response {
  if (error instanceof SchemaError) return apiError(400, 'INVALID_REQUEST');
  if (error instanceof StoreError) {
    if (error.code === 'UNAVAILABLE') return apiError(503, 'SERVICE_UNAVAILABLE', ['recheck']);
    if (error.code === 'NOT_FOUND') return apiError(404, 'NOT_FOUND');
    if (error.code === 'NOT_FINALIZED') return apiError(409, 'REQUEST_CONFLICT', ['recheck']);
    if (error.code === 'PENDING_REQUEST') return apiError(409, 'PENDING_REQUEST', ['recheck']);
    if (error.code === 'REVISION_CONFLICT') return apiError(409, 'REVISION_CONFLICT', ['recheck']);
    if (route === 'PUT /v1/operations/{id}') {
      return apiError(409, 'RESERVATION_CONFLICT', ['recheck']);
    }
    return apiError(409, 'REQUEST_CONFLICT', ['recheck']);
  }
  throw error;
}

export function createMockHttp({ store, clock }: {
  readonly store: MemoryStore;
  readonly clock: ManualClock;
}): MockHttp {
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Session>();
  let counter = 0;

  const fetch: ApiTransport = async (request) => {
    let parsed: ParsedApiRequest;
    try {
      const bodyText = request.method === 'GET' ? '' : await request.text();
      const body = bodyText === '' ? undefined : JSON.parse(bodyText) as unknown;
      const url = new URL(request.url);
      parsed = parseApiRequest(request.method, url.pathname + url.search, body);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SchemaError) {
        return apiError(400, 'INVALID_REQUEST');
      }
      throw error;
    }

    const route = parsed.route;
    const scope = parsed.scope;
    let result: unknown;
    let cookie: string | undefined;
    try {
      if (route === 'POST /v1/auth/challenge') {
        counter += 1;
        const challengeId = bytes32(counter);
        const nonce = bytes32(counter + 0x100000);
        const issuedAt = clock.now();
        challenges.set(challengeId, { scope, expiresAt: issuedAt + 300000, used: false });
        result = { challengeId, nonce, issuedAt, expiresAt: issuedAt + 300000 };
      } else if (route === 'POST /v1/auth/verify') {
        const challenge = challenges.get(parsed.challengeId ?? '');
        if (challenge === undefined || !scopeEqual(challenge.scope, scope)) {
          return apiError(401, 'UNAUTHENTICATED');
        }
        if (challenge.used) return apiError(401, 'CHALLENGE_USED');
        if (clock.now() > challenge.expiresAt) return apiError(401, 'CHALLENGE_EXPIRED');
        // This is an explicit mock authentication decision, not SIWE signature verification.
        challenge.used = true;
        counter += 1;
        const token = `mock-session-${counter}`;
        const sessionExpiresAt = clock.now() + 1800000;
        sessions.set(token, { scope, expiresAt: sessionExpiresAt });
        cookie = `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
        result = { sessionExpiresAt };
      } else {
        const token = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        const session = sessions.get(token ?? '');
        if (session === undefined || clock.now() >= session.expiresAt) {
          return apiError(401, 'UNAUTHENTICATED');
        }
        if (!scopeEqual(session.scope, scope)) return apiError(403, 'SCOPE_MISMATCH');

        if (route === 'PUT /v1/operations/{id}') {
          if (parsed.record === undefined || parsed.expectedRevision === undefined) {
            throw new SchemaError('INVALID_FIELD', 'record');
          }
          const saved = store.operations.put(parsed.record, parsed.expectedRevision);
          result = { scope, ...saved };
        } else if (route === 'GET /v1/operations') {
          result = { records: store.operations.list(scope).map((saved) => ({ scope, ...saved })) };
        } else if (route === 'POST /v1/rewards') {
          if (parsed.reward === undefined) throw new SchemaError('INVALID_FIELD', 'reward');
          result = { reward: store.rewards.create(parsed.reward) };
        } else if (route === 'GET /v1/rewards') {
          result = { rewards: store.rewards.list(scope) };
        } else if (route === 'GET /v1/rewards/{id}') {
          const reward = store.rewards.get(scope, parsed.id as never);
          if (reward === undefined) return apiError(404, 'NOT_FOUND');
          result = { reward };
        } else {
          if (parsed.id === undefined || parsed.outputId === undefined || parsed.blockHash === undefined) {
            throw new SchemaError('INVALID_FIELD', 'received');
          }
          result = { reward: store.rewards.markReceived(scope, parsed.id as never, parsed.outputId, parsed.blockHash) };
        }
      }

      const json = jsonBody(result);
      parseApiResponse(route, 200, JSON.parse(json) as unknown);
      if (store.control.consumeLostAck(route)) {
        throw new Error('ACK_LOST');
      }
      return new Response(json, {
        status: 200,
        headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { 'set-cookie': cookie }) },
      });
    } catch (error) {
      return mapFailure(error, route);
    }
  };

  return {
    fetch,
    control: {
      reset() {
        challenges.clear();
        sessions.clear();
        counter = 0;
      },
    },
  };
}
