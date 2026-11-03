import { operationId, type RecipientInfo, type OwnedUtxo, type LocalDraft } from '@confidential-utxo/core';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import { assertWithdrawalBinding, defaultTerms, fetchPayQuote, isQuoteFresh, parseEthAmount,
  selectPayInput, type Address, type Bytes32, type InputId, type MonotonicClock,
  type OperationId, type QuoteReader, type Scope } from '@confidential-utxo/uniswap';
import { isAddress, keccak256, toHex } from 'viem';
import { paymentContentHash, type PaymentPreparationPlan, type PreparationDecision,
  type PreparationDeployment } from './payment-preparation.js';

export interface PaymentDecisionDependencies {
  readonly scope: Scope;
  readonly verified: VerifiedDeployment;
  /** The pinned and verified Uniswap deployment for the same scope. */
  readonly deployment: PreparationDeployment;
  readonly inputs: () => readonly OwnedUtxo[];
  readonly quoteReader: QuoteReader;
  readonly latestBlockTime: () => Promise<bigint>;
  readonly clock: MonotonicClock;
}
export interface PayDecisionInput {
  readonly amount: string;
  readonly recipient: Address;
  readonly changeRecipient: RecipientInfo;
}
export interface WithdrawDecisionInput { readonly inputId: Bytes32 }

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new Error('INVALID_PAYMENT_DECISION'); }
function requireValid(condition: boolean): asserts condition { if (!condition) invalid(); }
function recordId(): Bytes32 { return toHex(crypto.getRandomValues(new Uint8Array(32))) as Bytes32; }
function eligible(input: OwnedUtxo, deps: PaymentDecisionDependencies): boolean {
  const context = deps.verified.context;
  return same(input.owner, deps.scope.owner) && input.chainId === context.chainId
    && same(input.pool, context.pool) && input.status === 'available'
    && input.checkpoint.mode === context.finalityMode
    && input.checkpoint.number >= context.deploymentBlock;
}
function assertContext(deps: PaymentDecisionDependencies): void {
  const { context } = deps.verified;
  requireValid(deps.scope.deploymentId.length > 0 && context.chainId > 0n
    && context.chainId === deps.deployment.chainId && same(context.pool, deps.deployment.pool)
    && same(deps.verified.manifest.pool.address, context.pool)
    && BigInt(deps.verified.manifest.chainId) === context.chainId
    && isAddress(deps.scope.owner) && isAddress(deps.deployment.adapter));
}
function assertCurrentInput(coin: OwnedUtxo, deps: PaymentDecisionDependencies): void {
  const current = deps.inputs().filter(input => same(input.id, coin.id));
  requireValid(current.length === 1 && eligible(current[0]!, deps)
    && current[0]!.opening.amount === coin.opening.amount
    && current[0]!.commitment.x === coin.commitment.x
    && current[0]!.commitment.y === coin.commitment.y
    && same(current[0]!.checkpoint.hash, coin.checkpoint.hash));
}
function assertDraft(draft: LocalDraft, selected: OwnedUtxo, deps: PaymentDecisionDependencies,
  amount: bigint, destination: Address, outputs: number): void {
  const request = draft.request;
  requireValid(draft.context.chainId === deps.verified.context.chainId
    && same(draft.context.pool, deps.verified.context.pool)
    && same(draft.context.verifier, deps.verified.context.verifier)
    && same(draft.context.parametersHash, deps.verified.context.parametersHash)
    && draft.context.deploymentBlock === deps.verified.context.deploymentBlock
    && draft.context.finalityMode === deps.verified.context.finalityMode
    && same(request.owner, deps.scope.owner) && request.kind === 2 && request.d === 0n
    && request.w === amount && same(request.destination, destination)
    && request.inputIds.length === 1 && same(request.inputIds[0]!, selected.id)
    && request.outputs.length === outputs && draft.inputOpenings.length === 1
    && draft.inputOpenings[0]?.amount === selected.opening.amount
    && same(draft.operationId, operationId(draft.context, request))
    && eligible(selected, deps));
}

/** Constructs exact #29 Worker payloads and decisions from verified scope and published #30 rules. */
export function createPaymentDecisions(deps: PaymentDecisionDependencies): {
  readonly payPlan: (input: PayDecisionInput) => Promise<PaymentPreparationPlan>;
  readonly withdrawPlan: (input: WithdrawDecisionInput) => Promise<PaymentPreparationPlan>;
} {
  function inputById(id: string): OwnedUtxo {
    requireValid(/^0x[0-9a-fA-F]{64}$/.test(id));
    const matches = deps.inputs().filter(input => same(input.id, id));
    requireValid(matches.length === 1 && eligible(matches[0]!, deps));
    return structuredClone(matches[0]!);
  }
  return {
    async payPlan(input) {
      assertContext(deps);
      const amount = parseEthAmount(input.amount);
      requireValid(isAddress(input.recipient) && input.changeRecipient !== undefined);
      const recipient = input.recipient;
      const changeRecipient = structuredClone(input.changeRecipient);
      const candidates = deps.inputs().filter(coin => eligible(coin, deps));
      const selected = selectPayInput(candidates.map(coin => ({ id: coin.id as InputId,
        valueWei: coin.opening.amount, owner: coin.owner as Address, state: 'available' as const })), amount, deps.scope.owner);
      requireValid(selected !== undefined);
      const coin = inputById(selected.id);
      const quote = await fetchPayQuote(deps.quoteReader, amount,
        { weth: deps.deployment.weth, dusd: deps.deployment.token }, deps.clock);
      const blockTime = await deps.latestBlockTime();
      requireValid(isQuoteFresh(quote, deps.clock.now()));
      const fixed = defaultTerms(quote, blockTime);
      requireValid(fixed.deadline > blockTime);
      const id = recordId();
      const payload: PaymentPreparationPlan['payload'] = {
        intent: { kind: 2, owner: deps.scope.owner, amount, destination: deps.deployment.adapter,
          changeRecipient, explicitIds: [coin.id] },
        context: structuredClone(deps.verified.context), inputs: [coin],
      };
      return { payload, decide(draft): PreparationDecision {
        assertContext(deps);
        requireValid(isQuoteFresh(quote, deps.clock.now()));
        assertCurrentInput(coin, deps);
        assertDraft(draft, coin, deps, amount, deps.deployment.adapter, 1);
        const terms = { operationId: draft.operationId as OperationId, owner: deps.scope.owner,
          ethAmount: amount, token: deps.deployment.token, minAmountOut: fixed.minAmountOut,
          recipient, deadline: fixed.deadline };
        assertWithdrawalBinding(draft, terms, deps.deployment);
        return { kind: 'pay', deployment: deps.deployment, quote: structuredClone(quote), terms,
          identity: { scope: deps.scope, recordId: id,
            contentHash: paymentContentHash(draft, terms, quote, deps.deployment) } };
      } };
    },
    async withdrawPlan(input) {
      assertContext(deps);
      const coin = inputById(input.inputId);
      const id = recordId();
      const payload: PaymentPreparationPlan['payload'] = {
        intent: { kind: 2, owner: deps.scope.owner, amount: coin.opening.amount,
          destination: deps.scope.owner, explicitIds: [coin.id] },
        context: structuredClone(deps.verified.context), inputs: [coin],
      };
      return { payload, decide(draft): PreparationDecision {
        assertContext(deps);
        assertCurrentInput(coin, deps);
        assertDraft(draft, coin, deps, coin.opening.amount, deps.scope.owner, 0);
        requireValid(draft.rangeProofs.length === 0);
        return { kind: 'withdraw', deployment: deps.deployment,
          identity: { scope: deps.scope, recordId: id,
            contentHash: keccak256(toHex(['confidential-utxo-full-withdraw', draft.operationId].join(':'))) as Bytes32 } };
      } };
    },
  };
}
