// @vitest-environment jsdom
import './setup-dom.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { createMockExperience } from '../src/mock/experience.js';
import { AppPage } from '../src/site/AppPage.js';
import { ScenarioWorkbench, createScenarioSession } from '../src/site/ScenarioWorkbench.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;

it('loads hash-unknown S-27 and advances one step without a transaction link', async () => {
  const experience = createMockExperience({ scope });
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} workbench={<ScenarioWorkbench experience={experience} />} />);
  fireEvent.change(screen.getByLabelText('Scenario'), { target: { value: 'S-27/hash-unknown' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load scenario' }));
  expect(screen.getByText(/Specification: S-27/)).toBeVisible();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next step' })); });
  expect(screen.getByText(/Status cannot be confirmed/i)).toBeVisible();
  expect(screen.queryByRole('link', { name: 'View simulated transaction' })).not.toBeInTheDocument();
  experience.dispose();
});

it('shows changed terms at S-34 and rejects an unknown ID without changing the current case', async () => {
  const experience = createMockExperience({ scope });
  const session = createScenarioSession(experience);
  expect(session.select('S-34/quote-changed-before-authorization')).toBe(true);
  expect(session.select('not-a-scenario')).toBe(false);
  expect(session.snapshot().scenario?.id).toBe('S-34/quote-changed-before-authorization');
  render(<AppPage controller={experience} config={{ mode: 'mock', deploymentId: 'local-v1' }} workbench={<ScenarioWorkbench experience={experience} session={session} />} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/Unknown scenario ID/i);
  for (let step = 0; step < 3; step += 1) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next step' })); });
  }
  fireEvent.click(screen.getByRole('tab', { name: 'Pay' }));
  expect(screen.getByText('Review changed terms')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Previous terms' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'New terms' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm new terms' })).toBeEnabled();
  experience.dispose();
});

it('sets quote age boundaries and resets S-41 without leaving pending work', async () => {
  const experience = createMockExperience({ scope });
  const session = createScenarioSession(experience);
  for (const [id, accepted] of [['S-35/quote-age-equal', true], ['S-35/quote-age-exceeded', false], ['S-35/clock-backwards', false]] as const) {
    expect(session.select(id)).toBe(true);
    while (session.snapshot().nextStep) await session.next();
    expect(experience.mock.control.journal().filter((entry) => entry.kind === 'start')).toHaveLength(accepted ? 1 : 0);
  }
  expect(session.select('S-41/request-in-progress')).toBe(true);
  await session.next();
  expect(experience.snapshot().rewardRequests[0]?.requestId).toBe(`0x${'66'.repeat(32)}`);
  await session.next();
  expect(experience.snapshot().cards.reward.phase).toBe('pending');
  session.reset();
  expect(experience.snapshot().cards.reward.phase).toBe('ready');
  expect(experience.snapshot().rewardRequests).toHaveLength(0);
  expect(experience.mock.control.journal()).toHaveLength(0);
  experience.dispose();
});

it('omits the scenario workbench when AppPage is rendered for live mode', () => {
  const experience = createMockExperience({ scope });
  render(<AppPage controller={experience} config={{ mode: 'live', deploymentId: 'local-v1' }} />);
  expect(screen.queryByLabelText('Scenario')).not.toBeInTheDocument();
  experience.dispose();
});
