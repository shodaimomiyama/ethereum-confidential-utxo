import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;

it('restores a hash-less pending request without creating another request', async () => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  first.advance();
  first.advance();
  const before = first.snapshot();
  expect(before.operations[0]?.txHashes).toEqual([]);

  const second = createMockExperience({ scope });
  await second.restore(first.save());
  expect(second.snapshot().operations[0]?.operationId).toBe(before.operations[0]?.operationId);
  expect(second.snapshot().rewardRequests[0]?.requestId).toBe(before.rewardRequests[0]?.requestId);
  expect(second.snapshot().operations[0]?.txHashes).toEqual([]);
  expect(second.snapshot().cards.reward.phase).toBe('pending');
  first.dispose();
  second.dispose();
});

it('rejects old and malformed mock sessions', () => {
  const experience = createMockExperience({ scope });
  expect(() => experience.restore('{')).toThrow();
  expect(() => experience.restore('{"version":0,"steps":[]}')).toThrow('version');
  expect(() => experience.restore('{"version":2,"steps":[{"kind":"action","action":42}]}')).toThrow('steps');
  expect(() => experience.restore('{"version":1,"steps":[]}')).toThrow('version');
  expect(() => experience.restore('{"version":2,"steps":[]}')).toThrow('scope');
  experience.dispose();
});

it('keeps Pay unavailable after reload until its quote is refreshed', async () => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  await first.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: scope.owner });
  const second = createMockExperience({ scope });
  await second.restore(first.save());
  expect(second.snapshot().cards.pay.phase).toBe('needs-preparation');
  expect(second.snapshot().cards.pay.reason).toBe('QUOTE_STALE');
  first.dispose();
  second.dispose();
});

it.each([
  { ...scope, deploymentId: 'other-deployment' } as Scope,
  { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope,
])('rejects a saved session from a different initial scope: %j', async (otherScope) => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  expect(first.snapshot().availablePrivateWei).toBe(6n * 10n ** 15n);

  const second = createMockExperience({ scope: otherScope });
  const before = second.snapshot();
  await expect(async () => second.restore(first.save())).rejects.toThrow('scope');
  expect(second.snapshot()).toEqual(before);
  expect(second.snapshot().availablePrivateWei).toBe(0n);
  expect(second.snapshot().operations).toHaveLength(0);
  expect(second.snapshot().rewardRequests).toHaveLength(0);

  const sameScope = createMockExperience({ scope });
  await sameScope.restore(first.save());
  expect(sameScope.snapshot().availablePrivateWei).toBe(first.snapshot().availablePrivateWei);
  expect(sameScope.snapshot().operations).toEqual(first.snapshot().operations);
  first.dispose();
  second.dispose();
  sameScope.dispose();
});

it('expires unapproved terms after reload and requires a fresh quote', async () => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  await first.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: scope.owner });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'minAmountOut', value: '1' });
  expect(first.snapshot().cards.pay.phase).toBe('confirm-terms');
  expect(first.snapshot().cards.pay.proposedQuote).toBeDefined();

  const second = createMockExperience({ scope });
  await second.restore(first.save());
  expect(second.snapshot().cards.pay.phase).toBe('needs-preparation');
  expect(second.snapshot().cards.pay.reason).toBe('QUOTE_STALE');
  expect(second.snapshot().cards.pay.quote).toBeUndefined();
  expect(second.snapshot().cards.pay.proposedQuote).toBeUndefined();
  expect((await second.dispatch({ type: 'confirm-terms', card: 'pay' })).kind).toBe('blocked');
  expect((await second.dispatch({ type: 'start', card: 'pay' })).kind).toBe('blocked');
  await second.dispatch({ type: 'edit', card: 'pay', field: 'minAmountOut', value: '0.2' });
  expect(second.snapshot().cards.pay.quote).toBeDefined();
  expect(await second.dispatch({ type: 'start', card: 'pay' })).toEqual({ kind: 'accepted' });
  first.dispose();
  second.dispose();
});

it('keeps a submitted Pay operation available for recheck after reload', async () => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  await first.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: scope.owner });
  await first.dispatch({ type: 'start', card: 'pay' });
  first.advance();
  first.advance();

  const second = createMockExperience({ scope });
  await second.restore(first.save());
  const payOperation = second.snapshot().operations.at(-1);
  expect(payOperation?.chainOutcome).toBe('pending');
  expect(payOperation?.txHashes).toEqual([]);
  expect(second.snapshot().cards.pay.phase).toBe('pending');
  expect(second.snapshot().cards.pay.quote).toBeDefined();
  expect(second.snapshot().operationActions[payOperation?.operationId ?? '']).toContain('recheck');
  expect(await second.dispatch({ type: 'recheck', operationId: payOperation!.operationId })).toEqual({ kind: 'accepted' });
  expect(second.snapshot().operations.at(-1)?.operationId).toBe(payOperation?.operationId);
  second.advance();
  second.advance();
  expect(second.snapshot().cards.pay.phase).toBe('complete');
  expect(second.snapshot().availablePrivateWei).toBe(3n * 10n ** 15n);
  first.dispose();
  second.dispose();
});

it('retains completed Pay history and change after reload', async () => {
  const first = createMockExperience({ scope });
  await first.dispatch({ type: 'connect-wallet' });
  await first.dispatch({ type: 'switch-network' });
  await first.dispatch({ type: 'prepare-recipient-key' });
  await first.dispatch({ type: 'refresh-balances' });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await first.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) first.advance();
  await first.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: scope.owner });
  await first.dispatch({ type: 'start', card: 'pay' });
  for (let step = 0; step < 4; step += 1) first.advance();

  const second = createMockExperience({ scope });
  await second.restore(first.save());
  expect(second.snapshot().cards.pay.phase).toBe('complete');
  expect(second.snapshot().cards.pay.quote).toBeDefined();
  expect(second.snapshot().operations).toEqual(first.snapshot().operations);
  expect(second.snapshot().availablePrivateWei).toBe(3n * 10n ** 15n);
  first.dispose();
  second.dispose();
});

it('attributes Pay to the owner that started it when a scope switch overlaps dispatch', async () => {
  const experience = createMockExperience({ scope });
  await experience.dispatch({ type: 'connect-wallet' });
  await experience.dispatch({ type: 'switch-network' });
  await experience.dispatch({ type: 'prepare-recipient-key' });
  await experience.dispatch({ type: 'refresh-balances' });
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await experience.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: scope.owner });

  const otherScope = { ...scope, owner: `0x${'22'.repeat(20)}` } as Scope;
  const [start, switchScope] = await Promise.all([
    experience.dispatch({ type: 'start', card: 'pay' }),
    experience.dispatch({ type: 'switch-scope', scope: otherScope }),
  ]);
  expect(start).toEqual({ kind: 'accepted' });
  expect(switchScope).toEqual({ kind: 'accepted' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  expect(experience.snapshot().availablePrivateWei).toBe(0n);
  expect(experience.snapshot().operations).toHaveLength(0);
  await experience.dispatch({ type: 'switch-scope', scope });
  expect(experience.snapshot().cards.pay.phase).toBe('complete');
  expect(experience.snapshot().availablePrivateWei).toBe(3n * 10n ** 15n);
  experience.dispose();
});
