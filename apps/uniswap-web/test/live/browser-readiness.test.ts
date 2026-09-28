import { expect, it } from 'vitest';
import { commit, type Opening } from '@confidential-utxo/crypto';
import type { OwnedUtxo, SyncResult } from '@confidential-utxo/core';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Bytes32, DeploymentId, QuoteReader, Scope } from '@confidential-utxo/uniswap';
import type { ViewState } from '../../src/contracts/index.js';
import { createBrowserReadiness } from '../../src/live/browser-readiness.js';
import type { OperationContext } from '../../src/live/operations.js';
import type { PreparationDeployment } from '../../src/live/payment-preparation.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const scope: Scope = { deploymentId: 'local' as DeploymentId, owner: address('1') };
const deployment: PreparationDeployment = { chainId: 31337n, pool: address('2'), adapter: address('3'),
  token: address('4'), router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
const verified = { context: { chainId: 31337n, pool: deployment.pool, verifier: address('9'),
  parametersHash: hash('a'), deploymentBlock: 0n, finalityMode: 'local-simulated' },
  manifest: { chainId: 31337, pool: { address: deployment.pool } } } as unknown as VerifiedDeployment;
const opening = { amount: 2n * 10n ** 18n, blinding: 3n } as Opening;
const coin: OwnedUtxo = { id: hash('b'), owner: scope.owner, opening, commitment: commit(opening),
  checkpoint: { number: 1n, hash: hash('c'), mode: 'local-simulated' }, status: 'available',
  chainId: 31337n, pool: deployment.pool };
const core: Extract<SyncResult, { status: 'complete' }> = { status: 'complete',
  checkpoint: coin.checkpoint, utxos: [coin], receiptFailures: [], availableWei: opening.amount };
const context = { scope, epoch: 1, check() {} } as OperationContext;
function view(): ViewState {
  return { scope, currentScope: scope, connection: 'connected', preparation: { wallet: true,
    network: true, key: true, authenticated: true, faucet: false, gas: false },
    utxos: [{ id: coin.id, amountWei: opening.amount, available: true }], selectedInput: {},
    operationCards: {}, operationActions: {}, publicEthWei: 0n, availablePrivateWei: opening.amount,
    pendingPrivateWei: 0n, isStale: false, storageAvailability: 'healthy', cards: {
      reward: { phase: 'invalid-input', input: { amount: '1' } },
      pay: { phase: 'invalid-input', input: { amount: '1', recipient: scope.owner } },
      deposit: { phase: 'invalid-input', input: { amount: '1' } },
      withdraw: { phase: 'invalid-input', input: { utxoId: coin.id } },
    }, operations: [], rewardRequests: [], allowedActions: [], reasons: {} };
}
function fixture() {
  let eth = 3n * 10n ** 18n;
  const reader: QuoteReader = { getAmountsOut: async amount => ({ blockHash: hash('c') as Bytes32,
    blockNumber: 1n, amounts: [amount, amount * 2n] }) };
  const readiness = createBrowserReadiness({ resolveVerified: () => verified,
    resolvePaymentDeployment: () => deployment, quote: () => ({ reader, latestBlockTime: async () => 100n }),
    publicEth: async () => eth, clock: { now: () => 100 } });
  return { readiness, setEth: (value: bigint) => { eth = value; } };
}
const recovered = { records: [], finalized: { outputs: [] }, availability: 'healthy', allowedActions: [] } as const;

it('enables all four valid cards using complete scoped core and public evidence', async () => {
  const f = fixture();
  const decision = await f.readiness.evaluateReady({ scope, context, core, recovered, view: view() });
  expect(decision.allowedActions).toEqual(expect.arrayContaining(['start:reward', 'start:pay', 'start:deposit', 'start:withdraw']));
  expect(decision.allowedActions).toEqual(expect.arrayContaining(['edit:reward', 'edit:pay', 'edit:deposit', 'edit:withdraw',
    'new-operation:reward', 'new-operation:pay', 'new-operation:deposit', 'new-operation:withdraw']));
  expect(decision.selectedInput.pay).toMatchObject({ id: coin.id, changeWei: 10n ** 18n });
  expect(decision.cards.pay.quote).toMatchObject({ quoteOut: 2n * 10n ** 18n });
  expect(decision.publicEthWei).toBe(3n * 10n ** 18n);
  expect(decision.gas).toBe(true);
});

it('withdraws gas and deposit permissions when the public balance falls', async () => {
  const f = fixture();
  await f.readiness.evaluateReady({ scope, context, core, recovered, view: view() });
  f.setEth(0n);
  const decision = await f.readiness.evaluateDraft({ scope, context, view: view(), card: 'deposit' });
  expect(decision.allowedActions).not.toContain('start:deposit');
  expect(decision.allowedActions).not.toContain('start:pay');
  expect(decision.allowedActions).not.toContain('start:withdraw');
  expect(decision.allowedActions).toContain('start:reward');
  expect(decision.publicEthWei).toBe(0n);
  expect(decision.gas).toBe(false);
});

it('rechecks edited input and never carries a ready action to invalid or stale draft', async () => {
  const f = fixture();
  await f.readiness.evaluateReady({ scope, context, core, recovered, view: view() });
  const edited = { ...view(), cards: { ...view().cards,
    pay: { phase: 'invalid-input' as const, input: { amount: '3', recipient: scope.owner } } } };
  const decision = await f.readiness.evaluateDraft({ scope, context, view: edited, card: 'pay' });
  expect(decision.allowedActions).not.toContain('start:pay');
  expect(decision.cards.pay.phase).toBe('invalid-input');
  await expect(f.readiness.evaluateDraft({ scope, context: { ...context, epoch: 2 }, view: edited,
    card: 'pay' })).rejects.toThrow('SCOPE_CHANGED');
});
