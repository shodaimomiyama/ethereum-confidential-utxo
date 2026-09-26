// @vitest-environment jsdom
import './setup-dom.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { AppPage } from '../src/site/AppPage.js';

it('keeps the controller alive when moving between four cards', () => {
  const controller = createMockExperience({ scope: {
    deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}`,
  } as Scope });
  render(<AppPage controller={controller} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  expect(screen.getByText('Simulated demo')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Demo reward' })).toHaveAttribute('aria-selected', 'true');
  for (const label of ['Pay', 'Deposit', 'Withdraw']) {
    expect(screen.getByRole('tab', { name: label })).toBeVisible();
  }
  expect(screen.getByText(/Public ETH/i)).toBeVisible();
  expect(screen.getByText(/Available private ETH/i)).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  expect(screen.getByRole('tab', { name: 'Pay' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Demo reward' }));
  expect(controller.snapshot().connection).toBe('disconnected');
  expect(screen.getByRole('link', { name: /About Dim/i })).toHaveAttribute('href', '/');
  controller.dispose();
});

it('releases controller listeners after StrictMode unmount', () => {
  const controller = createMockExperience({ scope: {
    deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}`,
  } as Scope });
  const subscribe = controller.subscribe;
  let activeSubscriptions = 0;
  controller.subscribe = (listener) => {
    activeSubscriptions += 1;
    const unsubscribe = subscribe(listener);
    return () => { activeSubscriptions -= 1; unsubscribe(); };
  };
  const view = render(<StrictMode><AppPage controller={controller} config={{ mode: 'mock', deploymentId: 'local-v1' }} /></StrictMode>);
  expect(activeSubscriptions).toBeGreaterThan(0);
  view.unmount();
  expect(activeSubscriptions).toBe(0);
  controller.dispose();
});

it('moves keyboard focus between action tabs with arrow keys', () => {
  const controller = createMockExperience({ scope: {
    deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}`,
  } as Scope });
  render(<AppPage controller={controller} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  const reward = screen.getByRole('tab', { name: 'Demo reward' });
  reward.focus();
  fireEvent.keyDown(reward, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Pay' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'Pay' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Pay' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Withdraw' })).toHaveFocus();
  controller.dispose();
});
