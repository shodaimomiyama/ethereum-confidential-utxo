import type { OperationRef, TxHash } from '@confidential-utxo/uniswap';
import type { SiteConfig } from './config.js';

export function operationHref(config: SiteConfig, operation: OperationRef, hash: TxHash | undefined): string | undefined {
  if (hash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return undefined;
  if (config.mode === 'mock') return `/app/mock-transaction/${hash}`;
  if (operation.scope.deploymentId !== config.deploymentId) return undefined;
  const base = config.explorerByDeployment?.[operation.scope.deploymentId];
  return base ? `${base.replace(/\/$/, '')}/tx/${hash}` : undefined;
}
