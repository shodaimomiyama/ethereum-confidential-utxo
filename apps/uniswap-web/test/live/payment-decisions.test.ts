import { expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildOperation, recipientInfoTypedData, type Context, type OwnedUtxo } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';
import type { Address, Bytes32, QuoteReader, Scope } from '@confidential-utxo/uniswap';
import { createPaymentDecisions } from '../../src/live/payment-decisions.js';
import { buildPreparedPayment, validatePreparedPayment, type PaymentPreparationPlan,
  type PreparationDeployment } from '../../src/live/payment-preparation.js';

const hex = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const address = (n: string) => `0x${n.repeat(40)}` as Address;
const account = privateKeyToAccount(hex('1'));
const scope = { deploymentId: 'local', owner: account.address } as Scope;
const deployment: PreparationDeployment = { chainId: 31337n, pool: address('2'), adapter: address('3'),
  token: address('4'), router: address('5'), factory: address('6'), weth: address('7'), pair: address('8') };
const context: Context = { chainId: deployment.chainId, pool: deployment.pool, verifier: deployment.pool,
  parametersHash: hex('9'), deploymentBlock: 0n, finalityMode: 'finalized' };
const verified = { context, manifest: { chainId: Number(context.chainId), pool: { address: context.pool } } } as VerifiedDeployment;
const coin = (n: string, amount: bigint): OwnedUtxo => { const opening = { amount, blinding: BigInt(`0x${n}`) }; return {
  id: hex(n), owner: scope.owner, opening, commitment: commit(opening),
  checkpoint: { number: 1n, hash: hex('a'), mode: 'finalized' }, status: 'available',
  chainId: context.chainId, pool: context.pool,
}; };
async function setup() {
  const unsigned = { chainId: context.chainId, pool: context.pool, owner: scope.owner,
    receivePublicKey: hex('c'), receiptFormat: 1, recipientInfoVersion: 1 } as const;
  const changeRecipient = { ...unsigned, signature: await account.signTypedData(
    recipientInfoTypedData(context, unsigned, scope.owner)) };
  const coins = [coin('d', 10n), coin('e', 12n)];
  let now = 100;
  let quoteOut = 100n;
  const quoteReader: QuoteReader = { getAmountsOut: async amount => ({
    blockHash: hex('a') as Bytes32, blockNumber: 1n, amounts: [amount, quoteOut],
  }) };
  const deps = { scope, verified, deployment, inputs: () => coins, quoteReader,
    latestBlockTime: async () => 1000n, clock: { now: () => now } };
  return { deps, coins, changeRecipient, setNow: (value: number) => { now = value; },
    setQuote: (value: bigint) => { quoteOut = value; } };
}
const build = async (plan: PaymentPreparationPlan) =>
  buildOperation(plan.payload.intent, plan.payload.context, { inputs: plan.payload.inputs,
    randomSalt: () => new Uint8Array(32).fill(4) });

it('selects one smallest available input and binds fixed quote, terms, draft and random record ID', async () => {
  const { deps, changeRecipient } = await setup();
  const planner = createPaymentDecisions(deps);
  const plan = await planner.payPlan({ amount: '0.000000000000000009', recipient: scope.owner, changeRecipient });
  expect(plan.payload.inputs.map(input => input.id)).toEqual([hex('d')]);
  expect(plan.payload.intent).toMatchObject({ kind: 2, amount: 9n, destination: deployment.adapter,
    explicitIds: [hex('d')] });
  const draft = await build(plan);
  const decision = plan.decide(draft);
  expect(decision.kind).toBe('pay');
  if (decision.kind !== 'pay') return;
  expect(decision.terms).toMatchObject({ ethAmount: 9n, minAmountOut: 99n, deadline: 1600n,
    recipient: scope.owner, operationId: draft.operationId });
  const prepared = buildPreparedPayment(draft, decision);
  expect(() => validatePreparedPayment(prepared, decision)).not.toThrow();
  expect(() => validatePreparedPayment(prepared, { ...decision,
    terms: { ...decision.terms, minAmountOut: 1n } })).toThrow();
  expect(() => plan.decide({ ...draft, request: { ...draft.request, w: 8n } })).toThrow();
  const other = await planner.payPlan({ amount: '0.000000000000000009', recipient: scope.owner, changeRecipient });
  expect(other.decide(await build(other)).identity.recordId).not.toBe(decision.identity.recordId);
});

it('rejects malformed amount, unavailable input, forbidden recipient and stale quote', async () => {
  const { deps, coins, changeRecipient, setNow } = await setup();
  const planner = createPaymentDecisions(deps);
  await expect(planner.payPlan({ amount: '9e-18', recipient: scope.owner, changeRecipient })).rejects.toThrow();
  await expect(planner.payPlan({ amount: '0.000000000000000012', recipient: scope.owner, changeRecipient })).rejects.toThrow();
  const plan = await planner.payPlan({ amount: '0.000000000000000009', recipient: deployment.adapter, changeRecipient });
  expect(() => plan.decide({} as never)).toThrow();
  const draft = await build(plan);
  expect(() => plan.decide(draft)).toThrow();
  const fresh = await planner.payPlan({ amount: '0.000000000000000009', recipient: scope.owner, changeRecipient });
  const freshDraft = await build(fresh);
  setNow(30_101);
  expect(() => fresh.decide(freshDraft)).toThrow();
  coins[0] = { ...coins[0]!, status: 'pending' };
  await expect(planner.withdrawPlan({ inputId: hex('d') as Bytes32 })).rejects.toThrow();
});

it('plans full withdrawal of the specified owned UTXO to its owner', async () => {
  const { deps } = await setup();
  const plan = await createPaymentDecisions(deps).withdrawPlan({ inputId: hex('e') as Bytes32 });
  expect(plan.payload.intent).toMatchObject({ amount: 12n, destination: scope.owner, explicitIds: [hex('e')] });
  const draft = await build(plan);
  const decision = plan.decide(draft);
  expect(decision.kind).toBe('withdraw');
  expect(() => buildPreparedPayment(draft, decision)).not.toThrow();
  expect(() => plan.decide({ ...draft, request: { ...draft.request, destination: deployment.adapter } })).toThrow();
});

it('keeps a quoted plan fixed and changes the confirmation hash for a new quote', async () => {
  const { deps, changeRecipient, setQuote } = await setup();
  const planner = createPaymentDecisions(deps);
  const input = { amount: '0.000000000000000009', recipient: scope.owner, changeRecipient };
  const before = await planner.payPlan(input);
  const draft = await build(before);
  const first = before.decide(draft);
  setQuote(200n);
  expect(before.decide(draft)).toEqual(first);
  const after = await planner.payPlan(input);
  const next = after.decide(draft);
  expect(next.kind).toBe('pay');
  if (first.kind !== 'pay' || next.kind !== 'pay') return;
  expect(next.terms.minAmountOut).toBe(198n);
  expect(next.identity.contentHash).not.toBe(first.identity.contentHash);
});
