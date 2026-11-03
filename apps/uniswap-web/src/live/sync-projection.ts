import { synchronize, type Context, type HistoryPort, type ReceiptKeyPort,
  type SyncResult as CoreSyncResult } from '@confidential-utxo/core';
import type { Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import { projectUnconfirmedSync } from './operations.js';

export interface SyncAction {
  readonly scope: Scope;
  readonly epoch: number;
  check(): void;
}

export interface FinalizedSyncDependencies {
  readonly previous: ViewState;
  readonly action: SyncAction;
  /** Supply the checked #30 deployment context and its scoped HistoryPort. */
  readonly coreContext: Context;
  readonly history: HistoryPort;
  readonly keys: ReceiptKeyPort;
  readonly previousCore?: CoreSyncResult;
  readonly storageAvailability?: ViewState['storageAvailability'];
}

/**
 * Projects only spendability that #30's synchronize has established. A complete
 * UTXO snapshot does not establish the outcome of an existing operation, so its
 * identifier survives for a separate #30/#55 recheck.
 */
export function projectCoreSync(previous: ViewState, result: CoreSyncResult,
  storageAvailability: ViewState['storageAvailability'] = previous.storageAvailability): ViewState {
  const safe = projectUnconfirmedSync(previous, storageAvailability);
  if (result.status !== 'complete' || storageAvailability !== 'healthy') return safe;
  const available = result.utxos.filter(utxo => utxo.status === 'available');
  if (available.reduce((sum, utxo) => sum + utxo.opening.amount, 0n) !== result.availableWei
    || result.utxos.some(utxo => utxo.owner.toLowerCase() !== previous.scope.owner.toLowerCase()
      || utxo.checkpoint.number !== result.checkpoint.number
      || utxo.checkpoint.hash.toLowerCase() !== result.checkpoint.hash.toLowerCase()
      || utxo.opening.amount < 0n)) return safe;
  return { ...safe,
    isStale: false,
    preparation: { ...safe.preparation, key: previous.preparation.key, gas: false },
    checkedAt: Date.now(),
    // This snapshot proves private state only. Public ETH needs an independent
    // account balance read pinned to the same chain context.
    publicEthWei: 0n,
    availablePrivateWei: result.availableWei,
    pendingPrivateWei: result.utxos.reduce((sum, utxo) => sum + (utxo.status === 'pending' ? utxo.opening.amount : 0n), 0n),
    utxos: result.utxos.map(utxo => ({ id: utxo.id, amountWei: utxo.opening.amount,
      available: utxo.status === 'available' })),
  };
}

/** Calls #30 core rather than deriving spendability from transaction hashes or UI records. */
export async function syncFinalizedForView(deps: FinalizedSyncDependencies): Promise<{
  readonly core: CoreSyncResult; readonly view: ViewState;
}> {
  deps.action.check();
  if (!sameScope(deps.previous.scope, deps.action.scope)) throw new Error('SCOPE_CHANGED');
  const core = await synchronize(deps.coreContext,
    { history: deps.history, keys: deps.keys, owners: [deps.action.scope.owner] }, deps.previousCore);
  deps.action.check();
  return { core, view: projectCoreSync(deps.previous, core, deps.storageAvailability) };
}
