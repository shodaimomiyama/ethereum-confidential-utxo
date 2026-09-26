import { expect, it, vi } from 'vitest';
import type { HistoryPort } from '@confidential-utxo/core';
import type { DeploymentConfig } from '../src/config.js';

const calls = vi.hoisted(() => ({
  createEthereumRpc: vi.fn(), verifyEthereumDeployment: vi.fn(), createHistoryPort: vi.fn(),
}));
vi.mock('@confidential-utxo/ethereum', () => calls);

import { loadEthereumHistory } from '../src/ethereum-provider.js';

const config: DeploymentConfig = {
  origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337,
  pool: '0x0000000000000000000000000000000000000001', finalityMode: 'finalized',
};
const manifest = { schemaVersion: 1 };
const source = JSON.stringify({ 'local-v1': { url: 'https://rpc.test', manifest } });

it('passes the fixed manifest through #30 verification and caches only successful histories', async () => {
  const client = {};
  const policy = {};
  const history = {} as HistoryPort;
  calls.createEthereumRpc.mockReturnValue({ client, policy });
  calls.verifyEthereumDeployment.mockResolvedValue({ context: {
    chainId: 31337n, pool: config.pool, finalityMode: 'finalized',
  }, manifest });
  calls.createHistoryPort.mockReturnValue(history);
  expect(await loadEthereumHistory('local-v1', config, source)).toBe(history);
  expect(calls.createEthereumRpc).toHaveBeenCalledWith({ url: 'https://rpc.test', mode: 'finalized' });
  expect(calls.verifyEthereumDeployment).toHaveBeenCalledWith(client, manifest, 'finalized');
  expect(calls.createHistoryPort).toHaveBeenCalledWith(
    expect.objectContaining({ manifest }), client, policy);
  expect(await loadEthereumHistory('local-v1', config, source)).toBe(history);
  expect(calls.verifyEthereumDeployment).toHaveBeenCalledTimes(1);
});

it('rejects deployment mismatches after verification', async () => {
  calls.createEthereumRpc.mockReturnValue({ client: {}, policy: {} });
  calls.verifyEthereumDeployment.mockResolvedValue({ context: {
    chainId: 31337n, pool: '0x0000000000000000000000000000000000000002', finalityMode: 'finalized',
  }, manifest });
  const wrongSource = JSON.stringify({ 'local-v1': { url: 'https://other-rpc.test', manifest } });
  await expect(loadEthereumHistory('local-v1', config, wrongSource)).rejects.toThrow('RPC_DEPLOYMENT_MISMATCH');
});
