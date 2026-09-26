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
  expect(() => experience.restore('{"version":1,"steps":[{"kind":"action","action":42}]}')).toThrow('steps');
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
