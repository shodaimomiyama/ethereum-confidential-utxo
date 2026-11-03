import { createSiweMessage } from 'viem/siwe';
import type { DeploymentId, Scope } from '@confidential-utxo/uniswap';
import { sameScope, type HttpClient } from './http.js';
import type { DeploymentLocation } from './scope.js';
import type { WalletEvent, WalletPort } from './wallet.js';

export class AuthFailure extends Error {
  constructor(readonly kind: 'scope' | 'challenge' | 'session') {
    super(kind);
    this.name = 'AuthFailure';
  }
}

export interface AuthDeploymentLocation extends DeploymentLocation {
  readonly siweUri: string;
}

export interface AuthSession {
  authenticate(scope: Scope): Promise<void>;
  isAuthenticated(scope: Scope): boolean;
  invalidate(): void;
  dispose(): void;
}

export function createAuthSession(options: {
  client: HttpClient;
  wallet: WalletPort;
  origin: string;
  resolveDeployment(deploymentId: DeploymentId): AuthDeploymentLocation | undefined;
  connection(): WalletEvent;
  now?: () => number;
}): AuthSession {
  const { client, wallet, resolveDeployment, connection } = options;
  const now = options.now ?? Date.now;
  const url = new URL(options.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new AuthFailure('challenge');
  let revision = 0;
  let disposed = false;
  let authenticated: { scope: Scope; expiresAt: number; epoch: number; chainId: bigint; pool: string; siweUri: string } | undefined;
  const invalidate = (): void => { revision++; authenticated = undefined; };
  const unsubscribe = wallet.subscribe(invalidate);
  return {
    async authenticate(requestedScope) {
      invalidate();
      const scope = { ...requestedScope };
      const generation = revision;
      const connected = connection();
      const epoch = connected.epoch;
      const deployment = resolveDeployment(scope.deploymentId);
      if (!deployment || !connected.scope || !sameScope(connected.scope, scope)) throw new AuthFailure('scope');
      const { chainId, pool, siweUri } = deployment;
      try {
        const uri = new URL(siweUri);
        if (uri.origin !== url.origin || uri.username || uri.password
          || chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new AuthFailure('challenge');
      } catch { throw new AuthFailure('challenge'); }
      const check = (): void => {
        const current = connection();
        const location = resolveDeployment(scope.deploymentId);
        if (disposed || revision !== generation || current.epoch !== epoch || !current.scope
          || !sameScope(current.scope, scope) || location?.chainId !== chainId
          || location.pool.toLowerCase() !== pool.toLowerCase() || location.siweUri !== siweUri) throw new AuthFailure('scope');
      };
      check();
      const challenge = await client.call('POST /v1/auth/challenge', { scope, body: { scope } });
      check();
      const validChallenge = (): void => {
        const time = now();
        if (challenge.issuedAt > time || challenge.expiresAt <= time
          || challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > 300000
          || !/^0x[0-9a-fA-F]{64}$/.test(challenge.nonce)) throw new AuthFailure('challenge');
      };
      validChallenge();
      const message = createSiweMessage({
        address: scope.owner, domain: url.host, uri: siweUri, version: '1',
        chainId: Number(chainId), nonce: challenge.nonce,
        issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt),
      });
      const signed = await wallet.personalSign(new TextEncoder().encode(message), 'api-login');
      check();
      validChallenge();
      if (!sameScope(signed.scope, scope) || signed.epoch !== epoch) throw new AuthFailure('scope');
      const startedAt = now();
      const verified = await client.call('POST /v1/auth/verify', { scope, body: {
        scope, challengeId: challenge.challengeId, siweMessage: message, signature: signed.value as `0x${string}`,
      } });
      check();
      if (verified.sessionExpiresAt <= now() || verified.sessionExpiresAt > now() + 1800000
        || verified.sessionExpiresAt < startedAt) throw new AuthFailure('session');
      authenticated = { scope, epoch, chainId, pool, siweUri, expiresAt: verified.sessionExpiresAt };
    },
    isAuthenticated(scope) {
      const current = connection();
      const deployment = resolveDeployment(scope.deploymentId);
      return !disposed && authenticated !== undefined && authenticated.expiresAt > now()
        && current.epoch === authenticated.epoch && current.scope !== undefined
        && sameScope(current.scope, scope) && sameScope(authenticated.scope, scope)
        && deployment !== undefined && deployment.chainId === authenticated.chainId
        && deployment.pool.toLowerCase() === authenticated.pool.toLowerCase()
        && deployment.siweUri === authenticated.siweUri;
    },
    invalidate,
    dispose() { disposed = true; invalidate(); unsubscribe(); },
  };
}
