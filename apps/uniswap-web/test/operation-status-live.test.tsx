// @vitest-environment jsdom
import './setup-dom.js';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { UiController, ViewState } from '../src/contracts/index.js';
import { OperationStatus } from '../src/site/OperationStatus.js';

it('offers receipt verification for a finalized reward operation', () => {
  const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
  const operationId = `0x${'aa'.repeat(32)}` as ViewState['operations'][number]['operationId'];
  const dispatch = vi.fn(async () => ({ kind: 'accepted' as const }));
  const view = { scope, currentScope: scope, isStale: false, storageAvailability: 'healthy',
    cards: { reward: { phase: 'confirmed-receipt-pending' }, pay: { phase: 'needs-preparation' },
      deposit: { phase: 'needs-preparation' }, withdraw: { phase: 'needs-preparation' } },
    rewardRequests: [], operations: [{ scope, operationId, attemptIds: [], txHashes: [],
      chainOutcome: 'finalized-success', receiptState: 'pending' }],
    operationCards: { [operationId]: 'reward' },
    operationActions: { [operationId]: ['recheck', 'acknowledge-receipt'] },
    allowedActions: [], reasons: {},
  } as unknown as ViewState;
  render(<OperationStatus view={view} controller={{ dispatch } as unknown as UiController}
    config={{ mode: 'live', deploymentId: 'local-v1' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check private receipt' }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'acknowledge-receipt', operationId });
});
