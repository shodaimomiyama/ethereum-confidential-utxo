// @vitest-environment jsdom
import './setup-dom.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { AppPage } from '../src/site/AppPage.js';
import { ScenarioWorkbench } from '../src/site/ScenarioWorkbench.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;

async function preparedPay() {
  const experience = createMockExperience({ scope });
  for (const type of ['connect-wallet', 'switch-network', 'prepare-recipient-key', 'refresh-balances'] as const) await experience.dispatch({ type });
  await experience.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: '0.006' });
  await experience.dispatch({ type: 'start', card: 'reward' });
  for (let step = 0; step < 4; step += 1) experience.advance();
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: '0.003' });
  await experience.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: owner });
  return experience;
}

it('keeps invalid terms editable, then permits correction', async () => {
  const experience = await preparedPay();
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  await act(async () => { fireEvent.change(screen.getByLabelText('Minimum output in dUSD'), { target: { value: '' } }); });
  expect(screen.getByLabelText('Minimum output in dUSD')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Start private payment' })).toBeDisabled();
  await act(async () => { fireEvent.change(screen.getByLabelText('Minimum output in dUSD'), { target: { value: '0.2' } }); });
  expect(screen.getByRole('button', { name: 'Start private payment' })).toBeEnabled();
  await act(async () => { fireEvent.change(screen.getByLabelText('Deadline (UTC timestamp)'), { target: { value: '1' } }); });
  expect(screen.getByRole('button', { name: 'Start private payment' })).toBeDisabled();
  expect(screen.getByLabelText('Deadline (UTC timestamp)')).toHaveValue('1');
  await act(async () => { fireEvent.change(screen.getByLabelText('Deadline (UTC timestamp)'), { target: { value: '18446744073709551615' } }); });
  expect(screen.getByText(/Unix seconds/i)).toBeVisible();
  experience.dispose();
});

it('requires review of a manually increased minimum above the quote', async () => {
  const experience = await preparedPay();
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  await act(async () => { fireEvent.change(screen.getByLabelText('Minimum output in dUSD'), { target: { value: '100' } }); });
  expect(screen.getByRole('heading', { name: 'Previous terms' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'New terms' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start private payment' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Confirm new terms' })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm new terms' })); });
  expect(experience.snapshot().cards.pay.phase).toBe('preparing');
  act(() => experience.advance());
  expect(experience.snapshot().cards.pay.phase).toBe('awaiting-approval');
  experience.dispose();
});

it('updates Pay eligibility when the workbench changes quote age', async () => {
  const experience = await preparedPay();
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} workbench={<ScenarioWorkbench experience={experience} />} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  const clock = screen.getByLabelText('Mock clock (milliseconds)');
  for (const [at, enabled] of [['30000', true], ['30001', false], ['-1', false]] as const) {
    fireEvent.change(clock, { target: { value: at } });
    fireEvent.click(screen.getByRole('button', { name: 'Set clock' }));
    if (enabled) expect(screen.getByRole('button', { name: 'Start private payment' })).toBeEnabled();
    else expect(screen.getByRole('button', { name: 'Start private payment' })).toBeDisabled();
  }
  experience.dispose();
});
