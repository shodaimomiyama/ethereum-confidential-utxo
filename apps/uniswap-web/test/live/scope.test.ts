import { expect, it } from 'vitest';
import type { DeploymentId, Scope } from '@confidential-utxo/uniswap';
import { ConnectionEpoch, matchesDeployment } from '../../src/live/scope.js';

const deploymentId = 'local-v1' as DeploymentId;
const scope = { deploymentId, owner: `0x${'11'.repeat(20)}` } as Scope;
const pool = `0x${'22'.repeat(20)}` as `0x${string}`;

it('rejects an old result even after switching A to B and back to A', () => {
  const epoch = new ConnectionEpoch();
  const firstA = epoch.current();
  const b = epoch.advance();
  const secondA = epoch.advance();
  expect(epoch.isCurrent(firstA)).toBe(false);
  expect(epoch.isCurrent(b)).toBe(false);
  expect(epoch.isCurrent(secondA)).toBe(true);
});

it('checks the observed chain and Pool against the injected deployment mapping', () => {
  const resolve = (id: DeploymentId) => id === deploymentId ? { chainId: 31337n, pool } : undefined;
  expect(matchesDeployment(scope, { chainId: 31337n, pool }, resolve)).toBe(true);
  expect(matchesDeployment(scope, { chainId: 1n, pool }, resolve)).toBe(false);
  expect(matchesDeployment(scope, { chainId: 31337n, pool: `0x${'33'.repeat(20)}` as `0x${string}` }, resolve)).toBe(false);
  expect(matchesDeployment({ ...scope, deploymentId: 'unknown' as DeploymentId }, { chainId: 31337n, pool }, resolve)).toBe(false);
});
