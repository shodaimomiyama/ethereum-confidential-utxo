// @vitest-environment jsdom
import './setup-dom.js';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { OperationRef, Scope, TxHash } from '@confidential-utxo/uniswap';
import { createManualClock, createMemoryStore } from '@confidential-utxo/uniswap/testing';
import { createMockUiController } from '../src/mock/controller.js';
import { AppPage } from '../src/site/AppPage.js';
import { operationHref } from '../src/site/explorer.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const operationId = `0x${'33'.repeat(32)}` as never;
const hash = `0x${'55'.repeat(32)}` as TxHash;
const operation: OperationRef = { scope, operationId, attemptIds: [], txHashes: [], chainOutcome: 'pending', receiptState: 'none' };

it('builds mock links locally and live links only for the matching deployment', () => {
  expect(operationHref({ mode: 'mock', deploymentId: 'local-v1' }, operation, undefined)).toBeUndefined();
  expect(operationHref({ mode: 'mock', deploymentId: 'local-v1' }, operation, hash)).toMatch(/^\/app\/mock-transaction\//);
  expect(operationHref({ mode: 'live', deploymentId: 'other-v1', explorerByDeployment: { 'local-v1': 'https://sepolia.etherscan.io' } }, operation, hash)).toBeUndefined();
  expect(operationHref({ mode: 'live', deploymentId: 'local-v1', explorerByDeployment: {} }, operation, hash)).toBeUndefined();
  expect(operationHref({ mode: 'live', deploymentId: 'local-v1', explorerByDeployment: { 'local-v1': 'https://sepolia.etherscan.io' } }, operation, hash)).toBe(`https://sepolia.etherscan.io/tx/${hash}`);
});

it('keeps hash-less pending work visible for recheck without an explorer link', () => {
  const ui = createMockUiController({ scope, store: createMemoryStore(), clock: createManualClock(0), scenario: 'ready' });
  ui.control.inject({ type: 'submitted', card: 'pay', operationId });
  render(<AppPage controller={ui} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  expect(screen.getByText(/pending confirmation/i)).toBeVisible();
  expect(screen.getByRole('button', { name: /Recheck status/i })).toBeEnabled();
  expect(screen.queryByRole('link', { name: /View simulated transaction/i })).not.toBeInTheDocument();
  ui.dispose();
});

it('does not show an old wallet operation after switching owner', async () => {
  const ui = createMockUiController({ scope, store: createMemoryStore(), clock: createManualClock(0), scenario: 'ready' });
  ui.control.inject({ type: 'submitted', card: 'pay', operationId });
  const { rerender } = render(<AppPage controller={ui} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  expect(screen.getByText(/pending confirmation/i)).toBeVisible();
  await ui.dispatch({ type: 'switch-scope', scope: { deploymentId: 'local-v1', owner: `0x${'22'.repeat(20)}` } as Scope });
  rerender(<AppPage controller={ui} config={{ mode: 'mock', deploymentId: 'local-v1' }} />);
  expect(screen.queryByText(/pending confirmation/i)).not.toBeInTheDocument();
  ui.dispose();
});
