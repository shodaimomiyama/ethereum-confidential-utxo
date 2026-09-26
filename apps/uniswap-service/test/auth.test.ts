import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createChallenge, readSession, verifyChallenge } from '../src/auth.js';
import type { DeploymentConfig } from '../src/config.js';

const config: DeploymentConfig = {
  origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337,
  pool: '0x0000000000000000000000000000000000000001',
};
const start = Date.parse('2026-09-27T00:00:00.000Z');

function signedMessage(account: ReturnType<typeof privateKeyToAccount>, scope: Scope, challenge: {
  nonce: string; issuedAt: number; expiresAt: number;
}, changes: Record<string, unknown> = {}) {
  return createSiweMessage({
    address: account.address,
    domain: 'site.test',
    uri: 'https://site.test/',
    version: '1',
    chainId: 31337,
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt),
    expirationTime: new Date(challenge.expiresAt),
    ...changes,
  });
}

it('issues a scoped session from a real SIWE signature and consumes the challenge once', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');

  await runInDurableObject(stub, async (_object, state) => {
    const challenge = createChallenge(state.storage, scope, start);
    expect(challenge.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(challenge.expiresAt - challenge.issuedAt).toBe(300_000);
    const message = signedMessage(account, scope, challenge);
    const signature = await account.signMessage({ message });
    const session = await verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, start + 1);
    expect(session.cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(session.expiresAt).toBe(start + 1_800_001);
    expect(readSession(state.storage, session.cookie, scope, start + 10)?.owner).toBe(account.address);
    expect(() => readSession(state.storage, session.cookie, scope, start + 1_800_001)).not.toThrow();
    expect(readSession(state.storage, session.cookie, scope, start + 1_800_001)).toBeUndefined();
    await expect(verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, start + 2))
      .rejects.toThrow(/CHALLENGE_USED/);
  });
});

it('allows only one success when the same SIWE challenge is verified concurrently', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const challenge = createChallenge(state.storage, scope, start);
    const message = signedMessage(account, scope, challenge);
    const signature = await account.signMessage({ message });
    const outcomes = await Promise.allSettled([
      verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, start + 1),
      verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, start + 1),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  });
});

it.each([
  ['domain', { domain: 'evil.test' }],
  ['URI', { uri: 'https://evil.test/' }],
  ['chain', { chainId: 1 }],
  ['nonce', { nonce: 'deadbeef' }],
  ['issued time', { issuedAt: new Date(start - 1000) }],
  ['expiry time', { expirationTime: new Date(start + 600_000) }],
])('rejects a signed SIWE message with a wrong %s', async (_label, changes) => {
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const challenge = createChallenge(state.storage, scope, start);
    const message = signedMessage(account, scope, challenge, changes);
    const signature = await account.signMessage({ message });
    await expect(verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, start + 1))
      .rejects.toThrow(/UNAUTHENTICATED/);
  });
});

it('rejects a forged signature and accepts a correct retry before expiration', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const challenge = createChallenge(state.storage, scope, start);
    const message = signedMessage(account, scope, challenge);
    const wrong = await attacker.signMessage({ message });
    await expect(verifyChallenge(state.storage, config, scope, challenge.challengeId, message, wrong, start + 1))
      .rejects.toThrow(/UNAUTHENTICATED/);
    const correct = await account.signMessage({ message });
    await expect(verifyChallenge(state.storage, config, scope, challenge.challengeId, message, correct, start + 2))
      .resolves.toMatchObject({ expiresAt: start + 1_800_002 });
  });
});

it('expires the challenge at its exact five-minute boundary', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const scope = { deploymentId: 'local-v1', owner: account.address } as Scope;
  const namespace = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = namespace.get(namespace.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async (_object, state) => {
    const challenge = createChallenge(state.storage, scope, start);
    const message = signedMessage(account, scope, challenge);
    const signature = await account.signMessage({ message });
    await expect(verifyChallenge(state.storage, config, scope, challenge.challengeId, message, signature, challenge.expiresAt))
      .rejects.toThrow(/CHALLENGE_EXPIRED/);
  });
});
