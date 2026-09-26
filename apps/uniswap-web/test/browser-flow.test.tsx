// @vitest-environment jsdom
import './setup-dom.js';
import { act, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { bootstrapSite } from '../src/site/bootstrap.js';
import { mockTransactionDetail } from '../src/site/mock-transaction.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;

it('replays the same pending reward request and operation after reload', async () => {
  const first = createMockExperience({ scope });
  for (const type of ['connect-wallet', 'switch-network', 'prepare-recipient-key', 'refresh-balances'] as const) await first.dispatch({ type });
  await first.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.003' });
  await first.dispatch({ type: 'start', card: 'reward' });
  first.advance();
  first.advance();
  const requestId = first.snapshot().rewardRequests[0]?.requestId;
  const operationId = first.snapshot().operations[0]?.operationId;
  const second = createMockExperience({ scope });
  await second.restore(first.save());
  expect(second.snapshot().rewardRequests[0]?.requestId).toBe(requestId);
  expect(second.snapshot().operations[0]?.operationId).toBe(operationId);
  expect(second.snapshot().cards.reward.phase).toBe('pending');
  first.dispose();
  second.dispose();
});

it('keeps the final field edit in the saved session and resolves mock transaction details locally', async () => {
  const experience = createMockExperience({ scope });
  let persisted = '';
  experience.subscribe(() => { persisted = experience.save(); });
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.003' });
  const restored = createMockExperience({ scope });
  await restored.restore(persisted);
  expect(restored.snapshot().cards.reward.input.amount).toBe('0.003');
  expect(mockTransactionDetail('0x' + '55'.repeat(32))).toContain('Simulated transaction');
  expect(mockTransactionDetail('bad')).toContain('Invalid');
  experience.dispose();
  restored.dispose();
});

it('accepts an injected live controller and directly renders mock transaction detail', async () => {
  const experience = createMockExperience({ scope });
  const container = document.createElement('div');
  document.body.append(container);
  let root: ReturnType<typeof bootstrapSite>;
  await act(async () => { root = bootstrapSite({ container, config: { mode: 'live', deploymentId: 'local-v1' }, controller: experience, pathname: '/app' }); });
  expect(screen.getByRole('heading', { name: 'Try Dim' })).toBeVisible();
  expect(screen.queryByLabelText('Scenario')).not.toBeInTheDocument();
  await act(async () => { root.unmount(); });
  await act(async () => { root = bootstrapSite({ container, config: { mode: 'mock', deploymentId: 'local-v1' }, pathname: `/app/mock-transaction/0x${'55'.repeat(32)}` }); });
  expect(screen.getByRole('heading', { name: 'Simulated transaction' })).toBeVisible();
  await act(async () => { root.unmount(); });
  container.remove();
  experience.dispose();
});
