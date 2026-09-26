import { createEthereumRpc, createHistoryPort, verifyEthereumDeployment } from '@confidential-utxo/ethereum';
import type { HistoryPort } from '@confidential-utxo/core';
import type { DeploymentConfig } from './config.js';

type RpcDeployment = { readonly url: string; readonly manifest: unknown };
const verifiedHistories = new Map<string, Promise<HistoryPort>>();

function rpcDeployment(source: string | undefined, deploymentId: string): RpcDeployment {
  if (source === undefined) throw new Error('RPC_DEPLOYMENT_UNAVAILABLE');
  const raw: unknown = JSON.parse(source);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || !Object.hasOwn(raw, deploymentId)) throw new Error('RPC_DEPLOYMENT_UNAVAILABLE');
  const entry: unknown = (raw as Record<string, unknown>)[deploymentId];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('RPC_DEPLOYMENT_UNAVAILABLE');
  }
  const { url, manifest } = entry as Record<string, unknown>;
  if (typeof url !== 'string' || url.length === 0 || manifest === undefined) {
    throw new Error('RPC_DEPLOYMENT_UNAVAILABLE');
  }
  return { url, manifest };
}

/** Verifies the deployment once per isolate; each HistoryPort read still pins its own chain observations. */
export function loadEthereumHistory(deploymentId: string, config: DeploymentConfig,
  source: string | undefined): Promise<HistoryPort> {
  const binding = rpcDeployment(source, deploymentId);
  const key = JSON.stringify([deploymentId, config.chainId, config.pool.toLowerCase(), config.finalityMode, binding]);
  const existing = verifiedHistories.get(key);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    const { client, policy } = createEthereumRpc({ url: binding.url, mode: config.finalityMode });
    const verified = await verifyEthereumDeployment(client, binding.manifest, config.finalityMode);
    if (verified.context.chainId !== BigInt(config.chainId)
      || verified.context.pool.toLowerCase() !== config.pool.toLowerCase()
      || verified.context.finalityMode !== config.finalityMode) {
      throw new Error('RPC_DEPLOYMENT_MISMATCH');
    }
    return createHistoryPort(verified, client, policy);
  })();
  verifiedHistories.set(key, pending);
  void pending.catch(() => { if (verifiedHistories.get(key) === pending) verifiedHistories.delete(key); });
  return pending;
}
