import { expect, it } from 'vitest';
import { loadEthereumHistory } from '../src/ethereum-provider.js';
import type { DeploymentConfig } from '../src/config.js';

const config: DeploymentConfig = {
  origin: 'https://site.test', siweUri: 'https://site.test/', chainId: 31337,
  pool: '0x0000000000000000000000000000000000000001', finalityMode: 'finalized',
};

it('requires an exact deployment RPC binding before any chain read', async () => {
  expect(() => loadEthereumHistory('local-v1', config, undefined)).toThrow('RPC_DEPLOYMENT_UNAVAILABLE');
  expect(() => loadEthereumHistory('local-v1', config, '{}')).toThrow('RPC_DEPLOYMENT_UNAVAILABLE');
  expect(() => loadEthereumHistory('local-v1', config, JSON.stringify({
    'other-v1': { url: 'https://rpc.test', manifest: {} },
  }))).toThrow('RPC_DEPLOYMENT_UNAVAILABLE');
  expect(() => loadEthereumHistory('local-v1', config, JSON.stringify({
    'local-v1': { url: 'https://rpc.test' },
  }))).toThrow('RPC_DEPLOYMENT_UNAVAILABLE');
  await expect(loadEthereumHistory('local-v1', config, JSON.stringify({
    'local-v1': { url: 'http://rpc.test', manifest: {} },
  }))).rejects.toThrow();
});
