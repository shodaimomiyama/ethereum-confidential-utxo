import type { Scope } from '@confidential-utxo/uniswap';
import { sha256, toHex, verifyMessage } from 'viem';
import type { Hex } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import type { DeploymentConfig } from './config.js';

const CHALLENGE_MS = 300_000;
const SESSION_MS = 1_800_000;
const COOKIE_NAME = 'ecu_session';

type ChallengeRow = {
  challenge_id: string;
  deployment_id: string;
  owner: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  used_at_ms: number | null;
};

type SessionRow = { deployment_id: string; owner: string; expires_at_ms: number };

function randomHex(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function normalizedOwner(scope: Scope): string {
  return scope.owner.toLowerCase();
}

export function createChallenge(storage: DurableObjectStorage, scope: Scope, nowMs: number) {
  const challengeId = randomHex();
  const nonce = randomHex();
  const expiresAt = nowMs + CHALLENGE_MS;
  storage.sql.exec(
    `INSERT INTO challenges
      (challenge_id, deployment_id, owner, nonce, issued_at_ms, expires_at_ms, used_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    challengeId, scope.deploymentId, normalizedOwner(scope), nonce, nowMs, expiresAt,
  );
  return { challengeId, nonce, issuedAt: nowMs, expiresAt };
}

function canonicalSiweMessage(
  config: DeploymentConfig,
  challenge: ChallengeRow,
  address: Hex,
): string {
  return createSiweMessage({
    address,
    domain: new URL(config.origin).host,
    uri: config.siweUri,
    version: '1',
    chainId: config.chainId,
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issued_at_ms),
    expirationTime: new Date(challenge.expires_at_ms),
  });
}

export async function verifyChallenge(
  storage: DurableObjectStorage,
  config: DeploymentConfig,
  scope: Scope,
  challengeId: string,
  message: string,
  signature: string,
  nowMs: number,
): Promise<{ readonly cookie: string; readonly expiresAt: number }> {
  const challenge = storage.sql.exec<ChallengeRow>(
    'SELECT * FROM challenges WHERE challenge_id = ?', challengeId,
  ).toArray()[0];
  if (challenge === undefined || challenge.deployment_id !== scope.deploymentId
    || challenge.owner !== normalizedOwner(scope)) throw new Error('UNAUTHENTICATED');
  if (challenge.used_at_ms !== null) throw new Error('CHALLENGE_USED');
  if (nowMs >= challenge.expires_at_ms) throw new Error('CHALLENGE_EXPIRED');
  const parsed = parseSiweMessage(message);
  if (parsed.address === undefined || parsed.address.toLowerCase() !== normalizedOwner(scope)
    || parsed.chainId !== config.chainId || parsed.domain !== new URL(config.origin).host
    || parsed.uri !== config.siweUri || parsed.nonce !== challenge.nonce
    || parsed.version !== '1' || parsed.issuedAt?.getTime() !== challenge.issued_at_ms
    || parsed.expirationTime?.getTime() !== challenge.expires_at_ms
    || message !== canonicalSiweMessage(config, challenge, parsed.address)
    || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error('UNAUTHENTICATED');
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: parsed.address, message, signature: signature as Hex });
  } catch {
    throw new Error('UNAUTHENTICATED');
  }
  if (!valid) throw new Error('UNAUTHENTICATED');

  const token = randomHex();
  const expiresAt = nowMs + SESSION_MS;
  storage.transactionSync(() => {
    const update = storage.sql.exec(
      'UPDATE challenges SET used_at_ms = ? WHERE challenge_id = ? AND used_at_ms IS NULL AND expires_at_ms > ?',
      nowMs, challengeId, nowMs,
    );
    if (update.rowsWritten !== 1) throw new Error('CHALLENGE_USED');
    storage.sql.exec(
      'INSERT INTO sessions (session_hash, deployment_id, owner, expires_at_ms) VALUES (?, ?, ?, ?)',
      sha256(token), scope.deploymentId, normalizedOwner(scope), expiresAt,
    );
  });
  return {
    cookie: `${COOKIE_NAME}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
    expiresAt,
  };
}

export function readSession(
  storage: DurableObjectStorage,
  cookie: string | null,
  scope: Scope,
  nowMs: number,
): Scope | undefined {
  const identity = readSessionIdentity(storage, cookie, nowMs);
  if (identity === undefined || identity.deploymentId !== scope.deploymentId
    || identity.owner.toLowerCase() !== normalizedOwner(scope)) return undefined;
  return scope;
}

export function readSessionIdentity(
  storage: DurableObjectStorage,
  cookie: string | null,
  nowMs: number,
): Scope | undefined {
  const token = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=(0x[0-9a-fA-F]{64})(?:;|$)`).exec(cookie ?? '')?.[1];
  if (token === undefined) return undefined;
  const session = storage.sql.exec<SessionRow>(
    'SELECT deployment_id, owner, expires_at_ms FROM sessions WHERE session_hash = ?',
    sha256(token as Hex),
  ).toArray()[0];
  if (session === undefined || nowMs >= session.expires_at_ms) return undefined;
  return { deploymentId: session.deployment_id, owner: session.owner } as Scope;
}
