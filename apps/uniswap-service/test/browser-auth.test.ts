import { env } from 'cloudflare:workers';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ApiTransport, Scope } from '@confidential-utxo/uniswap';
import { createAuthSession } from '../../uniswap-web/src/live/auth.js';
import { createHttpClient } from '../../uniswap-web/src/live/http.js';
import type { WalletEvent, WalletPort } from '../../uniswap-web/src/live/wallet.js';
import { parseDeploymentCatalog, resolveDeployment } from '../src/config.js';
import worker, { type ServiceEnv } from '../src/index.js';

// workerd omits browser credentials and rejects redirect:error. Adapt only Request
// construction; this transport calls the Worker directly and never follows redirects.
const EdgeRequest = Request;
beforeAll(() => {
  vi.stubGlobal('Request', class extends EdgeRequest {
    readonly credentials: RequestCredentials;
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.redirect === 'error') {
        expect(init.credentials).toBe('same-origin');
        expect(init.cache).toBe('no-store');
      }
      super(input, { ...init, redirect: init?.redirect === 'error' ? 'manual' : init?.redirect });
      this.credentials = init?.credentials ?? 'same-origin';
    }
  });
});
afterAll(() => vi.unstubAllGlobals());

function setup(siweUri?: string) {
  const serviceEnv = env as unknown as ServiceEnv;
  const config = resolveDeployment('local-v1', parseDeploymentCatalog(serviceEnv.DEPLOYMENTS_JSON));
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  let connection: WalletEvent = { scope, epoch: 1 };
  let listener: ((event: WalletEvent) => void) | undefined;
  let cookie: string | undefined;
  let setCookie: string | null = null;
  let challenge: { nonce: string; issuedAt: number; expiresAt: number } | undefined;
  let sessionExpiresAt = 0;
  let afterResponse: ((path: string) => void) | undefined;
  const personalSign = vi.fn(async (message: Uint8Array, _purpose: string) => ({
    value: await account.signMessage({ message: { raw: message } }), scope, epoch: connection.epoch,
  }));
  const wallet = { personalSign, subscribe(fn: typeof listener) { listener = fn; return () => { listener = undefined; }; } } as unknown as WalletPort;
  // Emulate browser-managed Origin and cookie headers, retaining the real HTTP client and Worker.
  const transport: ApiTransport = vi.fn(async request => {
    expect(request.credentials).toBe('same-origin');
    const headers = new Headers(request.headers);
    if (request.method !== 'GET') headers.set('origin', config.origin);
    if (cookie !== undefined) headers.set('cookie', cookie);
    const response = await worker.fetch(new Request(request, { headers }), serviceEnv);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/challenge')) challenge = await response.clone().json() as typeof challenge;
    if (path.endsWith('/verify') && response.ok) {
      setCookie = response.headers.get('set-cookie');
      cookie = setCookie?.split(';')[0];
      sessionExpiresAt = (await response.clone().json() as { sessionExpiresAt: number }).sessionExpiresAt;
    }
    afterResponse?.(path);
    return response;
  });
  const client = createHttpClient({ origin: config.origin, transport });
  const auth = createAuthSession({ client, wallet, origin: config.origin,
    resolveDeployment: () => ({ chainId: BigInt(config.chainId), pool: config.pool as `0x${string}`, siweUri: siweUri ?? config.siweUri }),
    connection: () => connection,
  });
  const change = () => { connection = { scope, epoch: connection.epoch + 1 }; listener?.(connection); };
  return { auth, client, config, scope, personalSign, transport, change,
    cookie: () => setCookie, challenge: () => challenge!, sessionExpiresAt: () => sessionExpiresAt,
    afterResponse: (fn: (path: string) => void) => { afterResponse = fn; },
  };
}

it('uses browser auth and HTTP with the real Worker verifier and cookie session', async () => {
  const h = setup();
  expect(h.personalSign).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
  expect(h.auth.isAuthenticated(h.scope)).toBe(false);
  await expect(h.client.call('GET /v1/operations', { scope: h.scope })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  expect(h.personalSign).not.toHaveBeenCalled();
  await h.auth.authenticate(h.scope);
  const challenge = h.challenge();
  expect(new TextDecoder().decode(h.personalSign.mock.calls[0]![0])).toBe(createSiweMessage({
    address: h.scope.owner, domain: new URL(h.config.origin).host, uri: h.config.siweUri,
    chainId: h.config.chainId, version: '1', nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt),
  }));
  expect(h.personalSign.mock.calls[0]![1]).toBe('api-login');
  expect(h.cookie()).toMatch(/^ecu_session=0x[0-9a-f]{64}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=1800$/);
  expect(h.sessionExpiresAt()).toBeGreaterThan(Date.now());
  expect(h.sessionExpiresAt()).toBeLessThanOrEqual(Date.now() + 1_800_000);
  expect(h.auth.isAuthenticated(h.scope)).toBe(true);
  expect((await h.client.call('GET /v1/operations', { scope: h.scope })).records).toEqual([]);
  await expect(h.client.call('GET /v1/operations', { scope: { ...h.scope, owner: '0x0000000000000000000000000000000000000002' as Scope['owner'] } })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  h.change();
  expect(h.auth.isAuthenticated(h.scope)).toBe(false);
  expect(h.personalSign).toHaveBeenCalledTimes(1);
  h.auth.dispose();
});

it('rejects a same-origin URI that does not match service configuration', async () => {
  const h = setup('https://site.test/another-login');
  await expect(h.auth.authenticate(h.scope)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  expect(h.auth.isAuthenticated(h.scope)).toBe(false);
  expect(h.cookie()).toBeNull();
  expect(h.personalSign).toHaveBeenCalledTimes(1);
  h.auth.dispose();
});

it.each(['challenge', 'verify'])('drops a real %s response after the connection epoch changes', async stage => {
  const h = setup();
  h.afterResponse(path => { if (path.endsWith(`/${stage}`)) h.change(); });
  await expect(h.auth.authenticate(h.scope)).rejects.toMatchObject({ kind: 'scope' });
  expect(h.auth.isAuthenticated(h.scope)).toBe(false);
  expect(h.personalSign).toHaveBeenCalledTimes(stage === 'challenge' ? 0 : 1);
  h.auth.dispose();
});
