import { allowedFor } from '../contracts/controller.js';
import type { UiController } from '../contracts/controller.js';
import type { Card, ViewState } from '../contracts/state.js';
import type { OperationRef } from '@confidential-utxo/uniswap';
import type { SiteConfig } from './config.js';
import { operationHref } from './explorer.js';

function statusText(operation: OperationRef): string {
  if (operation.chainOutcome === 'pending') return 'Pending confirmation';
  if (operation.chainOutcome === 'unknown') return 'Status cannot be confirmed';
  if (operation.chainOutcome === 'finalized-failure') return 'Attempt failed';
  if (operation.chainOutcome === 'finalized-success' && operation.receiptState === 'pending') return 'On-chain success; receipt check pending';
  if (operation.chainOutcome === 'finalized-success' && operation.receiptState === 'invalid') return 'On-chain success; private receipt needs rechecking';
  if (operation.chainOutcome === 'finalized-success') return 'Completed';
  return 'Not submitted';
}

export function OperationStatus({ view, controller, config }: {
  readonly view: ViewState; readonly controller: UiController; readonly config: SiteConfig;
}) {
  const operations = view.currentScope === undefined ? [] : view.operations.filter((operation) =>
    operation.scope.deploymentId === view.currentScope?.deploymentId
    && operation.scope.owner.toLowerCase() === view.currentScope?.owner.toLowerCase());
  return <section className="activity surface" aria-label="Activity">
    <h2>Activity</h2>
    {operations.length === 0 && view.rewardRequests.length === 0 && <p>No operations yet. Start with a demo reward or deposit.</p>}
    {view.rewardRequests.map((request) => <article className="activity-item" key={request.requestId}>
      <h3>Demo reward request</h3><p>{request.status === 'accepted' ? 'Request accepted' : request.status === 'pending' ? 'Distribution pending' : request.status === 'finalized' ? 'Distribution finalized; receipt pending' : request.status === 'received' ? 'Reward received' : `Request ${request.status}`}</p>
      <code title={request.requestId}>{request.requestId}</code>
      {request.status !== 'received' && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'recheck-reward', requestId: request.requestId })}>Recheck reward request</button>}
    </article>)}
    {operations.map((operation) => {
      const card: Card | undefined = view.operationCards[operation.operationId];
      const hash = operation.txHashes.at(-1);
      const href = operationHref(config, operation, hash);
      return <article className="activity-item" key={operation.operationId}>
        <h3>{card === 'reward' ? 'Demo reward' : card === 'pay' ? 'Pay' : card === 'deposit' ? 'Deposit' : card === 'withdraw' ? 'Withdraw' : 'Operation'}</h3>
        <p>{statusText(operation)}</p>
        <code title={operation.operationId}>{operation.operationId}</code>
        {href && <p><a href={href}>{config.mode === 'mock' ? 'View simulated transaction' : 'View on explorer'}</a></p>}
        {allowedFor(view, { type: 'recheck', operationId: operation.operationId }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'recheck', operationId: operation.operationId })}>Recheck status</button>}
        {allowedFor(view, { type: 'retry-attempt', operationId: operation.operationId }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'retry-attempt', operationId: operation.operationId })}>Retry same attempt</button>}
        {allowedFor(view, { type: 'resume-original', operationId: operation.operationId }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'resume-original', operationId: operation.operationId })}>Resume original submission</button>}
      </article>;
    })}
    <p className="muted">Full history: Coming soon</p>
  </section>;
}
