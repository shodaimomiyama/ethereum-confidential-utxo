import { expect, it, vi } from 'vitest';
import type { Bytes32, Scope } from '@confidential-utxo/uniswap';
import { createAuthSession } from '../../src/live/auth.js';
import { createHttpClient } from '../../src/live/http.js';
import type { WalletPort, WalletEvent } from '../../src/live/wallet.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'ab'.repeat(20)}` } as Scope;
const id = `0x${'33'.repeat(32)}` as Bytes32;
function setup(challenge = { challengeId: id, nonce: id, issuedAt: 1000, expiresAt: 301000 }) {
  let now = 1000;
  let listener: ((event: WalletEvent) => void) | undefined;
  const personalSign = vi.fn(async (_message: Uint8Array, _purpose: string) => ({ value: `0x${'aa'.repeat(65)}`, scope, epoch: 1 }));
  const wallet = { personalSign, subscribe: (fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; } } as unknown as WalletPort;
  const transport = vi.fn(async (request: Request) => request.url.endsWith('/challenge') ? Response.json(challenge) : Response.json({ sessionExpiresAt: now + 1800000 }));
  const auth = createAuthSession({ client: createHttpClient({ origin: 'https://mock.invalid', transport }), wallet, origin: 'https://mock.invalid', resolveDeployment: () => ({ chainId: 31337n, pool: `0x${'11'.repeat(20)}` }), connection: () => ({ scope, epoch: 1 }), now: () => now });
  return { auth, personalSign, transport, setNow: (value: number) => { now = value; }, change: () => listener?.({ epoch: 2 }) };
}

it('only signs on explicit authenticate and uses a dedicated SIWE signature', async () => {
  const { auth, personalSign, transport, setNow } = setup();
  expect(personalSign).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  await auth.authenticate(scope);
  expect(personalSign).toHaveBeenCalledTimes(1);
  expect(personalSign.mock.calls[0]?.[1]).toBe('api-login');
  const message = new TextDecoder().decode(personalSign.mock.calls[0]?.[0]);
  expect(message).toContain('mock.invalid wants you to sign in with your Ethereum account:');
  expect(message).toContain('URI: https://mock.invalid/');
  expect(message).toContain('Chain ID: 31337');
  expect(message).toContain(`Nonce: ${id.slice(2)}`);
  expect(message).toContain('Expiration Time: 1970-01-01T00:05:01.000Z');
  setNow(1801001);
  expect(auth.isAuthenticated(scope)).toBe(false);
  expect(personalSign).toHaveBeenCalledTimes(1);
});

it.each([{ issuedAt: 1001, expiresAt: 301001 }, { issuedAt: 0, expiresAt: 1000 }, { issuedAt: 1000, expiresAt: 301001 }])('rejects invalid challenge validity before signing: %j', async validity => {
  const { auth, personalSign } = setup({ challengeId: id, nonce: id, ...validity });
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'challenge' });
  expect(personalSign).not.toHaveBeenCalled();
});

it('rejects owner changes while signing before verification', async () => {
  const { auth, personalSign, change, transport } = setup();
  personalSign.mockImplementation(async () => { change(); return { value: `0x${'aa'.repeat(65)}`, scope, epoch: 1 }; });
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'scope' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('does not sign again on API session expiry', async () => {
  const { auth, personalSign, transport } = setup();
  await auth.authenticate(scope);
  transport.mockImplementation(async () => Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Session expired', allowedActions: [] } }, { status: 401 }));
  const client = createHttpClient({ origin: 'https://mock.invalid', transport });
  await expect(client.call('GET /v1/operations', { scope })).rejects.toMatchObject({ kind: 'api', code: 'UNAUTHENTICATED' });
  auth.invalidate();
  expect(auth.isAuthenticated(scope)).toBe(false);
  expect(personalSign).toHaveBeenCalledTimes(1);
});

it('rejects a challenge after the connection changes before signing', async () => {
  const { auth, transport, personalSign, change } = setup();
  transport.mockImplementation(async () => { change(); return Response.json({ challengeId: id, nonce: id, issuedAt: 1000, expiresAt: 301000 }); });
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'scope' });
  expect(personalSign).not.toHaveBeenCalled();
});

it('rejects an expired challenge after wallet signing without submitting verification', async () => {
  const { auth, personalSign, setNow, transport } = setup();
  personalSign.mockImplementation(async () => { setNow(301000); return { value: `0x${'aa'.repeat(65)}`, scope, epoch: 1 }; });
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'challenge' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('rejects a session longer than thirty minutes and disconnects on disposal', async () => {
  const { auth, transport, personalSign } = setup();
  transport.mockImplementation(async request => request.url.endsWith('/challenge')
    ? Response.json({ challengeId: id, nonce: id, issuedAt: 1000, expiresAt: 301000 })
    : Response.json({ sessionExpiresAt: 1801001 }));
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'session' });
  expect(auth.isAuthenticated(scope)).toBe(false);
  auth.dispose();
  await expect(auth.authenticate(scope)).rejects.toMatchObject({ kind: 'scope' });
  expect(personalSign).toHaveBeenCalledTimes(1);
});
