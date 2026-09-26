import type { Scope } from '@confidential-utxo/uniswap';
import type { Card, CardState, ViewState } from '../contracts/state.js';

function card(phase: CardState['phase'] = 'ready'): CardState {
  return { phase, input: {} };
}

export function initialScenario(scope: Scope, scenario: string): ViewState {
  const cards: Record<Card, CardState> = {
    reward: card(),
    pay: card(scenario === 'S-27/hash-unknown' ? 'unknown' : 'ready'),
    deposit: card(),
    withdraw: card(),
  };
  return {
    scope,
    publicEthWei: 0n,
    availablePrivateWei: 0n,
    pendingPrivateWei: 0n,
    isStale: false,
    storageAvailability: 'healthy',
    cards,
    operations: [],
    rewardRequests: [],
    allowedActions: [],
    reasons: {},
  };
}
