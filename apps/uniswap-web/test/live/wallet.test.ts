import { expect, it } from 'vitest';
import type { DeploymentId } from '@confidential-utxo/uniswap';
import { ConnectionEpoch } from '../../src/live/scope.js';
import { createMetaMaskWallet, type Eip1193Provider } from '../../src/live/wallet.js';

const alice = `0x${'11'.repeat(20)}`;
const bob = `0x${'22'.repeat(20)}`;
const pool = `0x${'33'.repeat(20)}` as `0x${string}`;
const deploymentId = 'local-v1' as DeploymentId;

class Provider implements Eip1193Provider {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly calls: { method: string; params?: unknown[] }[] = [];
  accounts: string[] = [alice];
  chain = '0x7a69';
  signPromise?: Promise<unknown>;
  resolveSign?: (value: unknown) => void;
  rejectSign?: (reason: unknown) => void;

  async request(request: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(request);
    if (request.method === 'eth_requestAccounts') return this.accounts;
    if (request.method === 'eth_chainId') return this.chain;
    if (request.method === 'personal_sign') return this.signPromise;
    if (request.method === 'eth_signTypedData_v4') return `0x${'44'.repeat(65)}`;
    if (request.method === 'eth_sendTransaction') return `0x${'55'.repeat(32)}`;
    if (request.method === 'wallet_switchEthereumChain') {
      this.chain = (request.params?.[0] as { chainId: string }).chainId;
      this.emit('chainChanged', this.chain);
      return null;
    }
    throw new Error('unexpected provider request');
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  holdSign(): void {
    this.signPromise = new Promise((resolve, reject) => {
      this.resolveSign = resolve;
      this.rejectSign = reject;
    });
  }
}

function setup(provider = new Provider()) {
  const epochs = new ConnectionEpoch();
  const wallet = createMetaMaskWallet(provider, deploymentId, () => ({ chainId: 31337n, pool }), epochs);
  return { provider, epochs, wallet };
}

it('rejects a pending signature after account B then A', async () => {
  const { provider, wallet } = setup();
  await wallet.connect();
  provider.holdSign();
  const signing = wallet.personalSign(new TextEncoder().encode('probe'), 'recipient-key');
  provider.emit('accountsChanged', [bob]);
  provider.emit('accountsChanged', [alice]);
  provider.resolveSign?.(`0x${'11'.repeat(65)}`);
  await expect(signing).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
});

it('returns a scoped value and sends purpose-specific methods', async () => {
  const { provider, wallet } = setup();
  const connection = await wallet.connect();
  expect(connection.scope).toEqual({ deploymentId, owner: alice });
  expect(connection.epoch).toBe(1);
  const signed = await wallet.typedSign({ hello: 'world' }, 'recipient-info');
  expect(signed.scope).toEqual(connection.scope);
  expect(signed.epoch).toBe(connection.epoch);
  expect(provider.calls.at(-1)).toEqual({ method: 'eth_signTypedData_v4', params: [alice, JSON.stringify({ hello: 'world' })] });
  const tx = await wallet.sendTransaction({ to: bob });
  expect(tx.value).toBe(`0x${'55'.repeat(32)}`);
  expect(provider.calls.at(-1)).toEqual({ method: 'eth_sendTransaction', params: [{ to: bob, from: alice }] });
});

it('maps refusal without leaking provider message or signature data', async () => {
  const { provider, wallet } = setup();
  await wallet.connect();
  provider.holdSign();
  const signing = wallet.personalSign(new Uint8Array([42]), 'api-login');
  provider.rejectSign?.({ code: 4001, message: 'secret probe' });
  await expect(signing).rejects.toMatchObject({ code: 'USER_REJECTED' });
  await expect(signing).rejects.not.toHaveProperty('message', 'secret probe');
  expect(provider.calls.at(-1)).toEqual({ method: 'personal_sign', params: ['0x2a', alice] });
});

it('rejects a wrong chain and unknown deployment', async () => {
  const { provider, wallet } = setup();
  provider.chain = '0x1';
  await expect(wallet.connect()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  expect(provider.calls.every(call => call.method !== 'personal_sign')).toBe(true);
  const unknown = createMetaMaskWallet(provider, deploymentId, () => undefined);
  await expect(unknown.connect()).rejects.toMatchObject({ code: 'UNKNOWN_DEPLOYMENT' });
});

it('advances the epoch on chain change, disconnect and dispose; removes listeners', async () => {
  const { provider, epochs, wallet } = setup();
  await wallet.connect();
  const events: number[] = [];
  const unsubscribe = wallet.subscribe(event => events.push(event.epoch));
  provider.emit('chainChanged', '0x1');
  expect(epochs.current()).toBe(2);
  expect(events).toEqual([2]);
  unsubscribe();
  provider.emit('disconnect', { message: 'secret' });
  expect(epochs.current()).toBe(3);
  expect(events).toEqual([2]);
  wallet.dispose();
  expect(epochs.current()).toBe(4);
  expect([...provider.listeners.values()].every(set => set.size === 0)).toBe(true);
});

it('switches from a mismatched chain to the deployment chain', async () => {
  const { provider, wallet } = setup();
  provider.chain = '0x1';
  await expect(wallet.connect()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  const switched = await wallet.switchChain(31337n);
  expect(switched.epoch).toBe(2);
  provider.holdSign();
  const signing = wallet.personalSign(new Uint8Array(), 'api-login');
  provider.resolveSign?.(`0x${'66'.repeat(65)}`);
  expect((await signing).scope.owner).toBe(alice);
});

it('rejects a scope change during typed data serialization', async () => {
  const { provider, wallet } = setup();
  await wallet.connect();
  const data = { toJSON: () => { provider.emit('accountsChanged', [bob]); return { safe: true }; } };
  await expect(wallet.typedSign(data, 'payment-authorization')).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
  expect(provider.calls.every(call => call.method !== 'eth_signTypedData_v4')).toBe(true);
});

it('reconciles an initial accountsChanged event with the permission response', async () => {
  class GrantingProvider extends Provider {
    override async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      if (args.method === 'eth_requestAccounts') this.emit('accountsChanged', [alice]);
      return super.request(args);
    }
  }
  const { wallet } = setup(new GrantingProvider());
  const connected = await wallet.connect();
  expect(connected.scope.owner).toBe(alice);
  expect(connected.epoch).toBeGreaterThan(0);
});

it('notifies subscribers of the first connected scope', async () => {
  const { wallet, epochs } = setup();
  const events: { epoch: number; owner?: string }[] = [];
  wallet.subscribe(event => events.push({ epoch: event.epoch, owner: event.scope?.owner }));
  const connected = await wallet.connect();
  expect(connected.epoch).toBe(1);
  expect(epochs.current()).toBe(1);
  expect(events).toEqual([{ epoch: 1, owner: alice }]);
});

it('accepts a switch response before chainChanged, then ignores its duplicate event', async () => {
  class LateEventProvider extends Provider {
    override async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      if (args.method === 'wallet_switchEthereumChain') {
        this.chain = (args.params?.[0] as { chainId: string }).chainId;
        setTimeout(() => this.emit('chainChanged', this.chain), 0);
        return null;
      }
      return super.request(args);
    }
  }
  const { wallet, provider, epochs } = setup(new LateEventProvider());
  provider.chain = '0x1';
  await expect(wallet.connect()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  const switched = await wallet.switchChain(31337n);
  expect(switched.scope.owner).toBe(alice);
  expect(epochs.current()).toBe(switched.epoch);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(epochs.current()).toBe(switched.epoch);
});

it('rejects a switch when the provider reports the wrong target', async () => {
  class WrongTargetProvider extends Provider {
    override async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      if (args.method === 'wallet_switchEthereumChain') {
        this.chain = '0x2';
        this.emit('chainChanged', this.chain);
        return null;
      }
      return super.request(args);
    }
  }
  const { wallet, provider } = setup(new WrongTargetProvider());
  provider.chain = '0x1';
  await expect(wallet.connect()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
  await expect(wallet.switchChain(31337n)).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
});
