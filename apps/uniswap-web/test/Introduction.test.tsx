// @vitest-environment jsdom
import './setup-dom.js';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Introduction } from '../src/site/Introduction.js';

it('introduces the reward-to-payment journey and its public disclosures', () => {
  render(<Introduction config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  expect(screen.getByRole('heading', { name: /Dim/i })).toBeVisible();
  expect(screen.getByText('Lightweight privacy for amounts on Ethereum.')).toBeVisible();
  expect(screen.getAllByRole('link', { name: /Try demo/i })[0]).toHaveAttribute('href', '/app');
  expect(screen.getByText(/public transaction graph/i)).toBeVisible();
  expect(screen.getByText(/payment ETH amount/i)).toBeVisible();
  expect(screen.getAllByText(/recipient/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/deposit/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/verified results/i)).not.toBeInTheDocument();
});
