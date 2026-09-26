import { createHash } from 'node:crypto';

// Deterministic, public, test-only keys. Never use these seeds with real funds.
export function testKeySeeds(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error('invalid test key slot');
  const label = `eip8182 issue10 delivery test-only slot ${slot}`;
  return {
    mlKemSeed: createHash('sha512').update(`${label} mlkem`).digest(),
    x25519SecretKey: createHash('sha256').update(`${label} x25519`).digest()
  };
}
