import type { DeploymentId, Scope } from '@confidential-utxo/uniswap';

export interface DeploymentLocation {
  readonly chainId: bigint;
  readonly pool: `0x${string}`;
}

export type ResolveDeployment = (deploymentId: DeploymentId) => DeploymentLocation | undefined;

export class ConnectionEpoch {
  private value = 0;

  current(): number { return this.value; }
  advance(): number { return ++this.value; }
  isCurrent(epoch: number): boolean { return epoch === this.value; }
}

export function matchesDeployment(
  scope: Scope,
  observed: DeploymentLocation,
  resolve: ResolveDeployment,
): boolean {
  const expected = resolve(scope.deploymentId);
  return expected !== undefined
    && expected.chainId === observed.chainId
    && expected.pool.toLowerCase() === observed.pool.toLowerCase();
}
