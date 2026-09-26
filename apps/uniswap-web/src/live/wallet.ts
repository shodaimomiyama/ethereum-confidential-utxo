import type { Address, DeploymentId, Scope } from '@confidential-utxo/uniswap';
import { ConnectionEpoch, type DeploymentLocation, type ResolveDeployment } from './scope.js';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export type WalletErrorCode =
  | 'SCOPE_CHANGED'
  | 'NOT_CONNECTED'
  | 'CHAIN_MISMATCH'
  | 'UNKNOWN_DEPLOYMENT'
  | 'USER_REJECTED'
  | 'PROVIDER_ERROR'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVALID_REQUEST';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode) {
    super(code);
    this.name = 'WalletError';
    this.code = code;
  }
}

export interface ScopedResult<T> {
  readonly value: T;
  readonly scope: Scope;
  readonly epoch: number;
}

export interface WalletEvent {
  readonly epoch: number;
  readonly scope?: Scope;
}

export interface WalletPort {
  connect(): Promise<ScopedResult<Scope>>;
  switchChain(chainId: bigint): Promise<ScopedResult<void>>;
  personalSign(message: Uint8Array, purpose: 'recipient-key' | 'api-login'): Promise<ScopedResult<string>>;
  typedSign(data: unknown, purpose: 'recipient-info' | 'pool-authorization' | 'payment-authorization'): Promise<ScopedResult<string>>;
  sendTransaction(request: unknown): Promise<ScopedResult<string>>;
  subscribe(listener: (event: WalletEvent) => void): () => void;
  dispose(): void;
}

function normalizeAddress(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new WalletError('INVALID_PROVIDER_RESPONSE');
  }
  return value.toLowerCase() as Address;
}

function parseChainId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new WalletError('INVALID_PROVIDER_RESPONSE');
  }
  return BigInt(value);
}

function providerError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001) {
    return new WalletError('USER_REJECTED');
  }
  return new WalletError('PROVIDER_ERROR');
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createMetaMaskWallet(
  provider: Eip1193Provider,
  deploymentId: DeploymentId,
  resolveDeployment: ResolveDeployment,
  epochs = new ConnectionEpoch(),
): WalletPort {
  let owner: Address | undefined;
  let chainId: bigint | undefined;
  let disposed = false;
  let accountRevision = 0;
  const listeners = new Set<(event: WalletEvent) => void>();

  const scope = (): Scope | undefined => owner === undefined ? undefined : { deploymentId, owner };
  const emit = (): void => {
    const event: WalletEvent = { epoch: epochs.current(), ...(scope() ? { scope: scope() } : {}) };
    for (const listener of listeners) listener(event);
  };
  const changed = (): void => { epochs.advance(); emit(); };
  const accountsChanged = (...args: unknown[]): void => {
    const accounts = args[0];
    try { owner = Array.isArray(accounts) && accounts.length > 0 ? normalizeAddress(accounts[0]) : undefined; }
    catch { owner = undefined; }
    accountRevision++;
    changed();
  };
  const chainChanged = (...args: unknown[]): void => {
    try { chainId = parseChainId(args[0]); }
    catch { chainId = undefined; }
    changed();
  };
  const disconnected = (): void => { owner = undefined; chainId = undefined; accountRevision++; changed(); };
  provider.on('accountsChanged', accountsChanged);
  provider.on('chainChanged', chainChanged);
  provider.on('disconnect', disconnected);

  const deployment = (): DeploymentLocation => {
    const location = resolveDeployment(deploymentId);
    if (!location) throw new WalletError('UNKNOWN_DEPLOYMENT');
    return location;
  };
  const sameDeployment = (expected: DeploymentLocation): boolean => {
    const current = resolveDeployment(deploymentId);
    return current !== undefined && current.chainId === expected.chainId
      && current.pool.toLowerCase() === expected.pool.toLowerCase();
  };
  const check = (epoch: number, requestedScope: Scope, expected: DeploymentLocation): void => {
    if (disposed || !epochs.isCurrent(epoch) || owner !== requestedScope.owner) {
      throw new WalletError('SCOPE_CHANGED');
    }
    if (!sameDeployment(expected)) throw new WalletError('SCOPE_CHANGED');
    if (chainId !== expected.chainId) throw new WalletError('CHAIN_MISMATCH');
  };
  const capture = (): { epoch: number; requestedScope: Scope; expected: DeploymentLocation } => {
    if (disposed) throw new WalletError('SCOPE_CHANGED');
    const requestedScope = scope();
    if (!requestedScope) throw new WalletError('NOT_CONNECTED');
    const epoch = epochs.current();
    const expected = deployment();
    check(epoch, requestedScope, expected);
    return { epoch, requestedScope, expected };
  };
  const invoke = async <T>(
    captured: ReturnType<typeof capture>, method: string, params: unknown[], parse: (value: unknown) => T,
  ): Promise<ScopedResult<T>> => {
    const { epoch, requestedScope, expected } = captured;
    check(epoch, requestedScope, expected);
    let raw: unknown;
    try { raw = await provider.request({ method, params }); }
    catch (error) { check(epoch, requestedScope, expected); throw providerError(error); }
    check(epoch, requestedScope, expected);
    return { value: parse(raw), scope: requestedScope, epoch };
  };
  const parseString = (value: unknown): string => {
    if (typeof value !== 'string') throw new WalletError('INVALID_PROVIDER_RESPONSE');
    return value;
  };

  return {
    async connect() {
      if (disposed) throw new WalletError('SCOPE_CHANGED');
      const expected = deployment();
      const epoch = epochs.current();
      let accounts: unknown;
      let observedChain: unknown;
      try {
        accounts = await provider.request({ method: 'eth_requestAccounts' });
        if (!epochs.isCurrent(epoch)) throw new WalletError('SCOPE_CHANGED');
        observedChain = await provider.request({ method: 'eth_chainId' });
      } catch (error) {
        if (disposed || !epochs.isCurrent(epoch)) throw new WalletError('SCOPE_CHANGED');
        throw providerError(error);
      }
      if (disposed || !epochs.isCurrent(epoch)) throw new WalletError('SCOPE_CHANGED');
      if (!Array.isArray(accounts) || accounts.length === 0) throw new WalletError('INVALID_PROVIDER_RESPONSE');
      const nextOwner = normalizeAddress(accounts[0]);
      const nextChain = parseChainId(observedChain);
      const connectionChanged = (owner !== undefined && owner !== nextOwner)
        || (chainId !== undefined && chainId !== nextChain);
      owner = nextOwner;
      chainId = nextChain;
      if (connectionChanged) changed();
      if (!sameDeployment(expected)) throw new WalletError('SCOPE_CHANGED');
      if (nextChain !== expected.chainId) throw new WalletError('CHAIN_MISMATCH');
      const resultScope: Scope = { deploymentId, owner: nextOwner };
      return { value: resultScope, scope: resultScope, epoch: epochs.current() };
    },
    async switchChain(target) {
      if (disposed) throw new WalletError('SCOPE_CHANGED');
      const expected = deployment();
      if (target !== expected.chainId) throw new WalletError('CHAIN_MISMATCH');
      if (!owner) throw new WalletError('NOT_CONNECTED');
      const requestedScope: Scope = { deploymentId, owner };
      const epoch = epochs.current();
      const originalAccountRevision = accountRevision;
      const targetHex = `0x${target.toString(16)}`;
      try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] }); }
      catch (error) {
        if (disposed || accountRevision !== originalAccountRevision || owner !== requestedScope.owner || !sameDeployment(expected)) throw new WalletError('SCOPE_CHANGED');
        throw providerError(error);
      }
      if (disposed || owner !== requestedScope.owner || !sameDeployment(expected)) throw new WalletError('SCOPE_CHANGED');
      // A chainChanged event for the requested chain is expected. A different
      // connection event during the request invalidates the result.
      if (accountRevision !== originalAccountRevision || chainId !== target || epochs.current() > epoch + 1) throw new WalletError('SCOPE_CHANGED');
      return { value: undefined, scope: requestedScope, epoch: epochs.current() };
    },
    personalSign(message, purpose) {
      if (purpose !== 'recipient-key' && purpose !== 'api-login') throw new WalletError('INVALID_REQUEST');
      const captured = capture();
      return invoke(captured, 'personal_sign', [hex(message), captured.requestedScope.owner], parseString);
    },
    typedSign(data, purpose) {
      if (purpose !== 'recipient-info' && purpose !== 'pool-authorization' && purpose !== 'payment-authorization') {
        throw new WalletError('INVALID_REQUEST');
      }
      const captured = capture();
      let serialized: string | undefined;
      try { serialized = JSON.stringify(data); }
      catch { throw new WalletError('INVALID_REQUEST'); }
      if (serialized === undefined) throw new WalletError('INVALID_REQUEST');
      return invoke(captured, 'eth_signTypedData_v4', [captured.requestedScope.owner, serialized], parseString);
    },
    sendTransaction(request) {
      const captured = capture();
      const { requestedScope } = captured;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        throw new WalletError('INVALID_REQUEST');
      }
      const transaction = request as Record<string, unknown>;
      if (transaction.from !== undefined) {
        let from: Address;
        try { from = normalizeAddress(transaction.from); }
        catch { throw new WalletError('INVALID_REQUEST'); }
        if (from !== requestedScope.owner) throw new WalletError('INVALID_REQUEST');
      }
      let params: Record<string, unknown>;
      try { params = { ...transaction, from: requestedScope.owner }; }
      catch { throw new WalletError('INVALID_REQUEST'); }
      return invoke(captured, 'eth_sendTransaction', [params], parseString);
    },
    subscribe(listener) {
      if (disposed) throw new WalletError('SCOPE_CHANGED');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      owner = undefined;
      chainId = undefined;
      provider.removeListener('accountsChanged', accountsChanged);
      provider.removeListener('chainChanged', chainChanged);
      provider.removeListener('disconnect', disconnected);
      changed();
      listeners.clear();
    },
  };
}
