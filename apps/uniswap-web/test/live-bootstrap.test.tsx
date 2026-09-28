// @vitest-environment jsdom
import './setup-dom.js';
import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { bootstrapLiveSite } from '../src/live-bootstrap.js';

const config = { mode: 'live' as const, deploymentId: 'local-v1' };
const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;

it('renders /app with the supplied controller and disposes it when the page unloads', async () => {
  history.replaceState(null, '', '/app');
  const controller = createMockExperience({ scope });
  const disposed = vi.spyOn(controller, 'dispose');
  const container = document.createElement('div');
  document.body.append(container);

  await act(async () => {
    await bootstrapLiveSite({ container, config, createController: () => controller });
  });
  expect(screen.getByRole('heading', { name: 'Try Dim' })).toBeVisible();
  expect(screen.queryByLabelText('Scenario')).not.toBeInTheDocument();

  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  expect(disposed).toHaveBeenCalledOnce();
  container.remove();
  history.replaceState(null, '', '/');
});

it('shows an unavailable live app when controller construction fails', async () => {
  history.replaceState(null, '', '/app');
  const container = document.createElement('div');
  document.body.append(container);
  let session: Awaited<ReturnType<typeof bootstrapLiveSite>>;

  await act(async () => {
    session = await bootstrapLiveSite({ container, config, createController: () => { throw new Error('secret deployment detail'); } });
  });
  expect(screen.getByRole('heading', { name: 'Dim app is not configured' })).toBeVisible();
  expect(container).not.toHaveTextContent('secret deployment detail');

  await act(async () => { session.dispose(); });
  container.remove();
  history.replaceState(null, '', '/');
});
