// @vitest-environment jsdom
import './setup-dom.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { AppPage } from '../src/site/AppPage.js';

it('guides a disconnected visitor through network, key and test ETH preparation', async () => {
  const controller = createMockExperience({ scope: { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope });
  render(<AppPage controller={controller} config={{ mode: 'mock', deploymentId: 'local-v1', faucetUrl: 'https://faucet.example/' }} />);
  expect(screen.getByRole('button', { name: /Connect simulated wallet/i })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Connect simulated wallet/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Switch to Sepolia/i })).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: /Switch to Sepolia/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Prepare privacy key/i })).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: /Prepare privacy key/i }));
  await waitFor(() => expect(screen.getByRole('link', { name: /Get test ETH/i })).toHaveAttribute('href', 'https://faucet.example/'));
  fireEvent.click(screen.getByRole('button', { name: /Recheck public balance/i }));
  await waitFor(() => expect(screen.getByText(/Ready to use/i)).toBeVisible());
  controller.dispose();
});
