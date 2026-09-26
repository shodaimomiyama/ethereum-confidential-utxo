import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;

async function prepare(experience: ReturnType<typeof createMockExperience>): Promise<void> {
  expect(experience.snapshot().connection).toBe('disconnected');
  await experience.dispatch({ type: 'connect-wallet' });
  await experience.dispatch({ type: 'switch-network' });
  await experience.dispatch({ type: 'prepare-recipient-key' });
  await experience.dispatch({ type: 'refresh-balances' });
  expect(experience.snapshot().preparation).toEqual({ wallet: true, network: true, key: true, faucet: true, gas: true });
}

it('walks through reward, Pay, and full Withdraw without a network request', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  expect(await experience.dispatch({ type: 'start', card: 'reward' })).toEqual({ kind: 'accepted' });
  experience.advance();
  expect(experience.snapshot().cards.reward.phase).toBe('awaiting-approval');
  experience.advance();
  expect(experience.snapshot().cards.reward.phase).toBe('pending');
  experience.advance();
  expect(experience.snapshot().cards.reward.phase).toBe('confirmed-receipt-pending');
  expect(experience.snapshot().availablePrivateWei).toBe(0n);
  experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(6n * 10n ** 15n);
  expect(experience.snapshot().rewardRequests).toHaveLength(1);

  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  expect(experience.snapshot().selectedInput.pay?.changeWei).toBe(3n * 10n ** 15n);
  expect(await experience.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'accepted' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(3n * 10n ** 15n);

  const remaining = experience.snapshot().utxos.find((item) => item.available);
  expect(remaining).toBeDefined();
  await experience.dispatch({ type: 'edit', card: 'withdraw', field: 'utxoId', value: remaining!.id });
  expect(await experience.dispatch({ type: 'start', card: 'withdraw' })).toEqual({ kind: 'accepted' });
  for (let step = 0; step < 3; step += 1) experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(0n);
  expect(experience.snapshot().publicEthWei).toBe(23n * 10n ** 15n);
  expect(experience.snapshot().cards.withdraw.phase).toBe('complete');
  experience.dispose();
});

it('can receive a deposit as an alternative first private UTXO', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'deposit', field: 'amount', value: '0.01' });
  expect(await experience.dispatch({ type: 'start', card: 'deposit' })).toEqual({ kind: 'accepted' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(10n ** 16n);
  expect(experience.snapshot().publicEthWei).toBe(10n ** 15n * 10n);
  experience.dispose();
});

it('refuses a deposit that would use all public ETH needed for gas', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'deposit', field: 'amount', value: '0.02' });
  expect(await experience.dispatch({ type: 'start', card: 'deposit' })).toEqual({ kind: 'blocked', reason: 'INSUFFICIENT_FUNDS' });
  experience.dispose();
});

it('does not replace a pending simulated operation with a second one', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await experience.dispatch({ type: 'edit', card: 'deposit', field: 'amount', value: '0.01' });
  await experience.dispatch({ type: 'start', card: 'reward' });
  expect(await experience.dispatch({ type: 'start', card: 'deposit' })).toEqual({ kind: 'blocked', reason: 'NOT_ALLOWED' });
  expect(experience.snapshot().cards.deposit.phase).toBe('ready');
  experience.dispose();
});

it('keeps a delayed Pay result in its original owner scope', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await experience.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  await experience.dispatch({ type: 'start', card: 'pay' });
  experience.advance(); experience.advance();
  const otherScope = { deploymentId: scope.deploymentId, owner: `0x${'22'.repeat(20)}` } as Scope;
  await experience.dispatch({ type: 'switch-scope', scope: otherScope });
  experience.advance(); experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(0n);
  expect(experience.snapshot().operations).toHaveLength(0);
  await experience.dispatch({ type: 'switch-scope', scope });
  expect(experience.snapshot().cards.pay.phase).toBe('complete');
  expect(experience.snapshot().availablePrivateWei).toBe(3n * 10n ** 15n);
  experience.dispose();
});

it('preserves hashless pending Pay and permits draft Pay requote after reload', async () => {
  const first = createMockExperience({ scope });
  await prepare(first);
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  await first.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  const draft = createMockExperience({ scope });
  await draft.restore(first.save());
  expect(draft.snapshot().cards.pay.reason).toBe('QUOTE_STALE');
  await draft.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.002' });
  expect(draft.snapshot().cards.pay.phase).toBe('ready');
  expect(draft.snapshot().cards.pay.quote).toBeDefined();
  await first.dispatch({ type: 'start', card: 'pay' });
  first.advance(); first.advance();
  const pending = createMockExperience({ scope });
  await pending.restore(first.save());
  const operationId = pending.snapshot().operations.at(-1)?.operationId;
  expect(pending.snapshot().cards.pay.phase).toBe('pending');
  expect(pending.snapshot().operationActions[operationId ?? '']).toContain('recheck');
  expect(pending.snapshot().operations.at(-1)?.txHashes).toHaveLength(0);
  first.dispose(); draft.dispose(); pending.dispose();
});

it('permits a fresh Pay after the prior payment completes', async () => {
  const experience = createMockExperience({ scope });
  await prepare(experience);
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.009' });
  await experience.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  await experience.dispatch({ type: 'start', card: 'pay' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  expect(await experience.dispatch({ type: 'new-operation', card: 'pay' })).toEqual({ kind: 'accepted' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.002' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  expect(await experience.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'accepted' });
  experience.dispose();
});
