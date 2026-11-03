// @vitest-environment jsdom
import './setup-dom.js';
import { act, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';

const composition = vi.hoisted(() => ({ createBrowserLiveController: vi.fn() }));
vi.mock('../src/live/browser-composition.js', () => composition);

afterEach(() => {
  vi.unstubAllEnvs();
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

it('starts the live /app entrypoint with a supplied controller', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_DIM_MODE', 'live');
  vi.stubEnv('VITE_DIM_DEPLOYMENT_ID', 'local-v1');
  history.replaceState(null, '', '/app');
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
  const controller = createMockExperience({ scope });
  composition.createBrowserLiveController.mockResolvedValue(controller);

  await act(async () => { await import('../src/main.js'); });

  expect(screen.getByRole('heading', { name: 'Try Dim' })).toBeVisible();
  expect(screen.queryByLabelText('Scenario')).not.toBeInTheDocument();
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
});
