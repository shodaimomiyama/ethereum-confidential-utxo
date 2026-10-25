// @vitest-environment jsdom
import './setup-dom.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { UiController, ViewState } from '../src/contracts/index.js';
import { createMockExperience } from '../src/mock/experience.js';
import { Preparation } from '../src/site/Preparation.js';

it('asks for explicit service authentication after key preparation in live mode', () => {
  const mock = createMockExperience({ scope: { deploymentId: 'local-v1',
    owner: `0x${'11'.repeat(20)}` } as Scope });
  const view: ViewState = { ...mock.snapshot(), preparation: { wallet: true, network: true,
    key: true, authenticated: false, faucet: false, gas: false } };
  const dispatch = vi.fn(async () => ({ kind: 'accepted' as const }));
  const controller = { ...mock, dispatch } as UiController;
  render(<Preparation view={view} controller={controller} config={{ mode: 'live', deploymentId: 'local-v1' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect service' }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'authenticate' });
  expect(screen.getByText('Network: Deployment local-v1')).toBeVisible();
});

it('shows live setup as ready when public gas exists without a faucet flag', () => {
  const mock = createMockExperience({ scope: { deploymentId: 'local-v1',
    owner: `0x${'11'.repeat(20)}` } as Scope });
  const view: ViewState = { ...mock.snapshot(), preparation: { wallet: true, network: true,
    key: true, authenticated: true, faucet: false, gas: true } };
  const controller = { ...mock, dispatch: vi.fn(async () => ({ kind: 'accepted' as const })) } as UiController;
  render(<Preparation view={view} controller={controller} config={{ mode: 'live', deploymentId: 'local-v1' }} />);
  expect(screen.getByText('Ready to use')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Recheck public balance' })).toBeNull();
});
