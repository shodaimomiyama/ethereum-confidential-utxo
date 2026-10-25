import { expect, it, vi } from 'vitest';
import type { ReceiptKeyPort } from '@confidential-utxo/core';
import type { RpcConnection, VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { createBrowserRewardDepositSuppliers } from '../../src/live/browser-reward-deposit.js';
import type { BrowserDeployment } from '../../src/live/deployment.js';
import type { OperationContext } from '../../src/live/operations.js';

const pool = `0x${'11'.repeat(20)}` as const;
const otherPool = `0x${'22'.repeat(20)}` as const;
const scope = { deploymentId: 'local-v1', owner: `0x${'33'.repeat(20)}` } as Scope;
const browser: BrowserDeployment = { deploymentId: scope.deploymentId, chainId: 31337n,
  pool, adapter: `0x${'44'.repeat(20)}`, origin: 'https://wallet.example.test',
  siweUri: 'https://wallet.example.test/login' };
const verified = { context: { chainId: 31337n, pool, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: pool } } } as VerifiedDeployment;
const rpc = { mode: 'local-simulated' } as RpcConnection;

function state(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true,
    network: true, key: false, faucet: false, gas: false }, utxos: [], selectedInput: {},
    operationCards: {}, operationActions: {}, publicEthWei: 0n, availablePrivateWei: 0n,
    pendingPrivateWei: 0n, isStale: true, storageAvailability: 'unavailable',
    cards: { reward: { phase: 'needs-preparation', input: {} }, pay: { phase: 'needs-preparation', input: {} },
      deposit: { phase: 'needs-preparation', input: {} }, withdraw: { phase: 'needs-preparation', input: {} } },
    operations: [], rewardRequests: [], allowedActions: [], reasons: {} };
}

function fixture(overrides: { browser?: BrowserDeployment; verified?: VerifiedDeployment; authenticated?: boolean } = {}) {
  const auth = { isAuthenticated: () => overrides.authenticated ?? false };
  const receiptKeys = vi.fn(() => ({ getKey: async () => { throw new Error('No key'); } }) as ReceiptKeyPort);
  const context = { scope, epoch: 1, check() {}, recordKey() { throw new Error('KEY_REQUIRED'); } } as unknown as OperationContext;
  const create = () => createBrowserRewardDepositSuppliers({ snapshot: state,
    resolveDeployment: () => overrides.browser ?? browser,
    resolveVerified: () => overrides.verified ?? verified,
    rpc, auth, receiptKeys, indexedDb: null });
  return { create, context, receiptKeys };
}

it('refuses a browser and core deployment mismatch before constructing the adapters', () => {
  const f = fixture({ browser: { ...browser, pool: otherPool } });
  expect(f.create).toThrow('DEPLOYMENT_MISMATCH');
});

it('routes reward listing through the scoped authenticated client', async () => {
  const f = fixture();
  const { reward } = f.create();
  await expect(reward.list(scope, f.context)).rejects.toThrow('UNAUTHENTICATED');
});

it('requires the scoped record key before constructing an encrypted deposit draft store', async () => {
  const f = fixture();
  const { deposit } = f.create();
  await expect(deposit.prepareDeposit(scope, { amount: '1' }, f.context)).rejects.toThrow('KEY_REQUIRED');
  expect(f.receiptKeys).not.toHaveBeenCalled();
});
