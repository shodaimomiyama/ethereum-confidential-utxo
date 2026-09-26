// @vitest-environment jsdom
import './setup-dom.js';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createManualClock, createMemoryStore } from '@confidential-utxo/uniswap/testing';
import { createMockUiController } from '../src/mock/controller.js';
import { createMockExperience } from '../src/mock/experience.js';
import { AppPage } from '../src/site/AppPage.js';

const owner = `0x${'11'.repeat(20)}`;
const scope = { deploymentId: 'local-v1', owner } as Scope;
const utxoId = `0x${'22'.repeat(32)}`;

function setup() {
  const ui = createMockUiController({ scope, store: createMemoryStore(), clock: createManualClock(0), scenario: 'interactive' });
  ui.control.inject({ type: 'utxos', utxos: [{ id: utxoId, amountWei: 10n ** 16n, available: true }] });
  render(<AppPage controller={ui} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  return ui;
}

async function edit(label: string, value: string) {
  await act(async () => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); });
}

it('starts blank and shows the Pay input, exact selected UTXO and quote conditions', async () => {
  const ui = setup();
  expect(screen.getByLabelText('Demo reward amount in ETH')).toHaveValue('');
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  expect(screen.getByLabelText('Pay amount in ETH')).toHaveValue('');
  await edit('Pay amount in ETH', '0.003');
  fireEvent.click(screen.getByRole('button', { name: 'Use my address' }));
  act(() => { ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 300n, latestBlockTimestamp: 1_790_460_000 }); });
  expect(screen.getByLabelText('Recipient address')).toHaveValue(owner);
  expect(screen.getByText(/selected UTXO/i)).toBeVisible();
  expect(screen.getByText(utxoId)).toBeVisible();
  expect(screen.getByText(/0.007 ETH.*change/i)).toBeVisible();
  expect(screen.getByLabelText('Minimum output in dUSD')).toBeVisible();
  expect(screen.getByLabelText('Deadline (UTC timestamp)')).toBeVisible();
  ui.dispose();
});

it('shows new Pay terms for review and blocks confirmation while the old authorization is active', async () => {
  const ui = setup();
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  await edit('Pay amount in ETH', '0.003');
  await edit('Recipient address', owner);
  act(() => { ui.control.inject({ type: 'quote', startedAt: 0, quoteOut: 100n, latestBlockTimestamp: 1_790_460_000 }); });
  act(() => { ui.control.inject({ type: 'reservation-ack', card: 'pay' }); });
  act(() => { ui.control.inject({ type: 'awaiting-approval', card: 'pay', purpose: 'pool-authorization' }); });
  act(() => { ui.control.inject({ type: 'quote', startedAt: 1, quoteOut: 200n, latestBlockTimestamp: 1_790_460_001 }); });
  expect(screen.getByText(/previous terms/i)).toBeVisible();
  expect(screen.getByRole('heading', { name: 'New terms' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm new terms' })).toBeDisabled();
  const before = ui.control.journal().length;
  fireEvent.click(screen.getByRole('button', { name: 'Confirm new terms' }));
  expect(ui.control.journal()).toHaveLength(before);
  ui.dispose();
});

it('separates deposit amount from public gas and confirms full UTXO withdrawal disclosure', async () => {
  const ui = setup();
  fireEvent.click(screen.getByRole('tab', { name: 'Deposit' }));
  expect(screen.getByLabelText('Deposit amount in ETH')).toHaveValue('');
  expect(screen.getByText(/gas is paid separately/i)).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Withdraw' }));
  await act(async () => { fireEvent.change(screen.getByLabelText('UTXO to withdraw'), { target: { value: utxoId } }); });
  expect(screen.getByText(/full 0.01 ETH/i)).toBeVisible();
  expect(screen.getByText(/publicly visible/i)).toBeVisible();
  ui.dispose();
});

it('distinguishes invalid decimal, unavailable service, and invalid private receipt', async () => {
  const ui = setup();
  await edit('Demo reward amount in ETH', '1e-3');
  expect(screen.getByRole('alert')).toHaveTextContent(/decimal/i);
  const panel = screen.getByRole('tabpanel');
  expect(within(panel).getByRole('button', { name: 'Request demo reward' })).toBeDisabled();
  act(() => { ui.control.inject({ type: 'validation-result', card: 'reward', phase: 'ready', input: { amount: '0.001' } }); });
  expect(within(panel).getByRole('button', { name: 'Request demo reward' })).toBeEnabled();
  act(() => { ui.control.inject({ type: 'receipt-invalid', card: 'reward', operationId: `0x${'33'.repeat(32)}` as never }); });
  expect(screen.getByRole('alert')).toHaveTextContent(/receipt/i);
  ui.dispose();
});

it('shows distinct no-single-input, stale quote and service-unavailable recovery without starting', async () => {
  const store = createMemoryStore();
  const ui = createMockUiController({ scope, store, clock: createManualClock(0), scenario: 'interactive' });
  ui.control.inject({ type: 'utxos', utxos: [{ id: utxoId, amountWei: 10n ** 16n, available: true }] });
  render(<AppPage controller={ui} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  await edit('Pay amount in ETH', '0.02');
  await edit('Recipient address', owner);
  expect(screen.getByRole('alert')).toHaveTextContent(/single available private UTXO/i);
  await edit('Pay amount in ETH', '0.003');
  act(() => { ui.control.inject({ type: 'invalidate-quote' }); });
  expect(screen.getByRole('alert')).toHaveTextContent(/quote is stale/i);
  fireEvent.click(screen.getByRole('tab', { name: 'Deposit' }));
  act(() => { ui.control.inject({ type: 'public-balance', amountWei: 10n ** 16n }); });
  await edit('Deposit amount in ETH', '0.003');
  store.control.setUnavailable(true);
  act(() => { ui.control.inject({ type: 'public-balance', amountWei: 10n ** 16n }); });
  expect(screen.getByRole('alert')).toHaveTextContent(/service is unavailable/i);
  expect(screen.getByRole('button', { name: 'Start deposit' })).toBeDisabled();
  expect(ui.control.journal().filter((entry) => entry.kind === 'start' || entry.kind === 'send')).toHaveLength(0);
  ui.dispose();
});

it('keeps submission, chain finality and private receipt as visible separate phases', async () => {
  const experience = createMockExperience({ scope });
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  for (const label of ['Connect simulated wallet', 'Switch to Sepolia', 'Prepare privacy key', 'Recheck public balance']) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
  }
  await edit('Demo reward amount in ETH', '0.003');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request demo reward' })); });
  expect(within(screen.getByRole('tabpanel')).getByText('Preparing request')).toBeVisible();
  act(() => experience.advance());
  expect(within(screen.getByRole('tabpanel')).getByText('Waiting for wallet approval')).toBeVisible();
  act(() => experience.advance());
  expect(within(screen.getByRole('tabpanel')).getByText('Submitted; waiting for confirmation')).toBeVisible();
  act(() => experience.advance());
  expect(within(screen.getByRole('tabpanel')).getByText('On-chain success; private receipt pending')).toBeVisible();
  expect(screen.getByText('0 ETH', { selector: 'strong' })).toBeVisible();
  act(() => experience.advance());
  expect(within(screen.getByRole('tabpanel')).getByText('Completed')).toBeVisible();
  expect(screen.getByText('0.003 ETH', { selector: 'strong' })).toBeVisible();
  experience.dispose();
});
