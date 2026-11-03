import type { OwnedUtxo, SyncResult } from '@confidential-utxo/core';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import { defaultTerms, fetchPayQuote, isQuoteFresh, parseEthAmount, selectPayInput,
  type Address, type InputId, type MonotonicClock, type QuoteReader, type Scope } from '@confidential-utxo/uniswap';
import { isAddress } from 'viem';
import type { Card, CardState, ValidationReason, ViewState } from '../contracts/index.js';
import { sameScope } from './http.js';
import type { OperationPortDependencies } from './operation-port.js';
import type { OperationContext } from './operations.js';
import type { PreparationDeployment } from './payment-preparation.js';

type CompleteCore = Extract<SyncResult, { status: 'complete' }>;
type Decision = Pick<ViewState, 'cards' | 'allowedActions' | 'reasons' | 'selectedInput'> & {
  readonly publicEthWei: bigint; readonly gas: boolean;
};
type ReadyEvidence = Parameters<NonNullable<OperationPortDependencies['recomputeReady']>>[0];
type DraftEvidence = Parameters<NonNullable<OperationPortDependencies['evaluateDraft']>>[0];
const cards = ['reward', 'pay', 'deposit', 'withdraw'] as const;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);
const validAddress = (value: unknown): value is `0x${string}` => typeof value === 'string'
  && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const validId = (value: unknown): value is `0x${string}` => typeof value === 'string'
  && /^0x[0-9a-fA-F]{64}$/.test(value);

export interface BrowserReadinessDependencies {
  readonly resolveVerified: (id: Scope['deploymentId']) => VerifiedDeployment | undefined;
  readonly resolvePaymentDeployment: (id: Scope['deploymentId']) => PreparationDeployment | undefined;
  /** The scoped #55 quote reader must validate its deployment and RPC chain on each call. */
  readonly quote: (context: OperationContext) => { readonly reader: QuoteReader;
    readonly latestBlockTime: () => Promise<bigint> };
  /** Fresh public account balance from the selected chain; an unverified result must throw. */
  readonly publicEth: (context: OperationContext) => Promise<bigint>;
  readonly clock: MonotonicClock;
}

/** Derive card permissions only from a healthy #30 snapshot and fresh public evidence. */
export function createBrowserReadiness(deps: BrowserReadinessDependencies): {
  readonly evaluateReady: NonNullable<OperationPortDependencies['recomputeReady']>;
  readonly evaluateDraft: NonNullable<OperationPortDependencies['evaluateDraft']>;
} {
  let cached: { readonly scope: Scope; readonly epoch: number; readonly core: CompleteCore;
    readonly verified: string; readonly payment: string } | undefined;

  function checked(scope: Scope, context: OperationContext, view: ViewState): {
    verified: VerifiedDeployment; payment: PreparationDeployment; verifiedId: string; paymentId: string;
  } {
    context.check();
    if (!sameScope(scope, context.scope) || !sameScope(scope, view.scope)
      || view.connection !== 'connected' || view.isStale || view.storageAvailability !== 'healthy') {
      cached = undefined;
      throw new Error('SCOPE_CHANGED');
    }
    const verified = deps.resolveVerified(scope.deploymentId);
    const payment = deps.resolvePaymentDeployment(scope.deploymentId);
    if (!verified || !payment || verified.context.chainId !== payment.chainId
      || BigInt(verified.manifest.chainId) !== payment.chainId
      || !same(verified.context.pool, payment.pool)
      || !same(verified.manifest.pool.address, payment.pool)) {
      cached = undefined;
      throw new Error('SCOPE_CHANGED');
    }
    return { verified, payment, verifiedId: signature(verified), paymentId: signature(payment) };
  }

  async function evaluate(scope: Scope, context: OperationContext, view: ViewState,
    core: CompleteCore): Promise<Decision> {
    const initial = checked(scope, context, view);
    if (core.checkpoint.mode !== initial.verified.context.finalityMode
      || core.checkpoint.number < initial.verified.context.deploymentBlock
      || core.utxos.some(coin => !same(coin.owner, scope.owner)
        || coin.chainId !== initial.verified.context.chainId
        || !same(coin.pool, initial.verified.context.pool)
        || !same(coin.checkpoint.hash, core.checkpoint.hash)
        || coin.checkpoint.number !== core.checkpoint.number)) throw new Error('SCOPE_CHANGED');
    const publicEth = await deps.publicEth(context);
    const afterBalance = checked(scope, context, view);
    if (initial.verifiedId !== afterBalance.verifiedId || initial.paymentId !== afterBalance.paymentId
      || publicEth < 0n) throw new Error('SCOPE_CHANGED');
    const eligible = core.utxos.filter(coin => coin.status === 'available');
    const nextCards: Record<Card, CardState> = { ...view.cards };
    const selected: Partial<Record<Card, ViewState['selectedInput'][Card]>> = {};
    const allowed = new Set(view.allowedActions.filter(action => !action.startsWith('start:') && action !== 'confirm-terms'));
    for (const card of cards) {
      allowed.add(`edit:${card}`);
      allowed.add(`new-operation:${card}`);
    }
    const reasons: Record<string, ValidationReason> = { ...view.reasons };
    function mark(card: Card, reason?: ValidationReason, choice?: ViewState['selectedInput'][Card],
      quote?: CardState['quote']): void {
      const previous = view.cards[card];
      const key = `start:${card}`;
      if (reason) {
        nextCards[card] = { ...previous, phase: reason === 'INPUT_INVALID' || reason === 'INVALID_DECIMAL'
          || reason === 'NO_SINGLE_INPUT'
          ? 'invalid-input' : 'needs-preparation', reason, quote: undefined, proposedQuote: undefined };
        reasons[key] = reason;
      } else {
        nextCards[card] = { ...previous, phase: 'ready', reason: undefined, quote, proposedQuote: undefined };
        if (choice) selected[card] = choice;
        allowed.add(key);
        delete reasons[key];
      }
    }
    function amount(input: string | undefined): bigint | undefined {
      try { return parseEthAmount(input ?? ''); } catch { return undefined; }
    }
    function blocked(card: Card): boolean {
      return view.operations.some(operation => view.operationCards[operation.operationId] === card
        && (operation.chainOutcome === 'pending' || operation.chainOutcome === 'unknown'));
    }
    const base = view.preparation.wallet && view.preparation.network && view.preparation.key;
    const activeReward = view.rewardRequests.some(request => !['received', 'ended-without-distribution'].includes(request.status));
    mark('reward', !base || !view.preparation.authenticated ? 'PREPARATION_MISSING'
      : activeReward ? 'REWARD_PENDING'
        : amount(view.cards.reward.input.amount) === undefined ? 'INVALID_DECIMAL' : undefined);
    const depositAmount = amount(view.cards.deposit.input.amount);
    mark('deposit', !base ? 'PREPARATION_MISSING' : blocked('deposit') ? 'RESULT_UNKNOWN'
      : depositAmount === undefined ? 'INVALID_DECIMAL'
        : publicEth <= depositAmount ? 'INSUFFICIENT_FUNDS' : undefined);
    const withdrawId = view.cards.withdraw.input.utxoId;
    const withdrawCoin = validId(withdrawId) ? eligible.filter(coin => same(coin.id, withdrawId)) : [];
    mark('withdraw', !base ? 'PREPARATION_MISSING' : blocked('withdraw') ? 'RESULT_UNKNOWN'
      : publicEth <= 0n ? 'GAS_REQUIRED'
        : withdrawCoin.length !== 1 ? 'NO_SINGLE_INPUT' : undefined,
    withdrawCoin.length === 1 ? { id: withdrawCoin[0]!.id,
      amountWei: withdrawCoin[0]!.opening.amount, changeWei: 0n } : undefined);
    const payAmount = amount(view.cards.pay.input.amount);
    const payRecipient = view.cards.pay.input.recipient;
    let payReason: ValidationReason | undefined = !base ? 'PREPARATION_MISSING'
      : blocked('pay') ? 'RESULT_UNKNOWN' : publicEth <= 0n ? 'GAS_REQUIRED'
        : payAmount === undefined || !validAddress(payRecipient) ? 'INPUT_INVALID' : undefined;
    let payChoice: ViewState['selectedInput'][Card];
    let payQuote: CardState['quote'];
    if (!payReason && payAmount !== undefined) {
      const input = selectPayInput(eligible.map(coin => ({ id: coin.id as InputId, valueWei: coin.opening.amount,
        owner: coin.owner as Address, state: 'available' as const })), payAmount, scope.owner);
      if (!input) payReason = 'NO_SINGLE_INPUT';
      else {
        const coin = eligible.find(item => same(item.id, input.id))!;
        payChoice = { id: coin.id, amountWei: coin.opening.amount,
          changeWei: coin.opening.amount - payAmount };
        try {
          const source = deps.quote(context);
          const quote = await fetchPayQuote(source.reader, payAmount,
            { weth: initial.payment.weth, dusd: initial.payment.token }, deps.clock);
          const blockTime = await source.latestBlockTime();
          context.check();
          if (!isQuoteFresh(quote, deps.clock.now())) throw new Error('QUOTE_STALE');
          const defaults = defaultTerms(quote, blockTime);
          const rawMinimum = view.cards.pay.input.minAmountOut;
          const minimum = rawMinimum === undefined || rawMinimum === '' ? defaults.minAmountOut : parseEthAmount(rawMinimum);
          const rawDeadline = view.cards.pay.input.deadline;
          const deadline = rawDeadline === undefined || rawDeadline === '' ? defaults.deadline
            : /^[1-9][0-9]*$/.test(rawDeadline) ? BigInt(rawDeadline) : 0n;
          if (minimum > quote.quoteOut || deadline <= blockTime || deadline >= 1n << 64n) {
            payReason = 'INPUT_INVALID';
          } else payQuote = { startedAt: quote.startedAtMs, quoteOut: quote.quoteOut,
            minAmountOut: minimum, deadline };
        } catch (error) {
          context.check();
          payReason = error instanceof Error && error.message === 'QUOTE_STALE'
            ? 'QUOTE_STALE' : 'SERVICE_UNAVAILABLE';
        }
      }
    }
    mark('pay', payReason, payChoice, payQuote);
    const final = checked(scope, context, view);
    if (initial.verifiedId !== final.verifiedId || initial.paymentId !== final.paymentId) {
      cached = undefined;
      throw new Error('SCOPE_CHANGED');
    }
    return { cards: nextCards, allowedActions: [...allowed], reasons, selectedInput: selected,
      publicEthWei: publicEth, gas: publicEth > 0n };
  }

  return {
    async evaluateReady(evidence: ReadyEvidence) {
      if (evidence.core.status !== 'complete' || evidence.recovered.availability !== 'healthy') {
        cached = undefined;
        throw new Error('SCOPE_CHANGED');
      }
      const decision = await evaluate(evidence.scope, evidence.context, evidence.view, evidence.core);
      const current = checked(evidence.scope, evidence.context, evidence.view);
      cached = { scope: { ...evidence.scope }, epoch: evidence.context.epoch,
        core: structuredClone(evidence.core), verified: current.verifiedId, payment: current.paymentId };
      return decision;
    },
    async evaluateDraft(evidence: DraftEvidence) {
      const current = checked(evidence.scope, evidence.context, evidence.view);
      if (!cached || !sameScope(cached.scope, evidence.scope) || cached.epoch !== evidence.context.epoch
        || cached.verified !== current.verifiedId || cached.payment !== current.paymentId) {
        cached = undefined;
        throw new Error('SCOPE_CHANGED');
      }
      return evaluate(evidence.scope, evidence.context, evidence.view, cached.core);
    },
  };
}
