import { allowedFor } from '../../contracts/controller.js';
import type { UiController } from '../../contracts/controller.js';
import type { ViewState } from '../../contracts/state.js';
import { CardFeedback } from './CardFeedback.js';

export function Reward({ view, controller }: { readonly view: ViewState; readonly controller: UiController }) {
  const card = view.cards.reward;
  return <div className="card-form">
    <h2>Demo reward</h2>
    <p>Request a small private test ETH reward. Distribution and private receipt are separate steps.</p>
    <label htmlFor="reward-amount">Demo reward amount in ETH</label>
    <input id="reward-amount" type="text" inputMode="decimal" autoComplete="off" value={card.input.amount ?? ''}
      disabled={!allowedFor(view, { type: 'edit', card: 'reward', field: 'amount', value: '' })}
      onChange={(event) => void controller.dispatch({ type: 'edit', card: 'reward', field: 'amount', value: event.target.value })} />
    <CardFeedback card={card} blockedReason={view.reasons['start:reward']} />
    <button type="button" className="button primary" disabled={!allowedFor(view, { type: 'start', card: 'reward' })}
      onClick={() => void controller.dispatch({ type: 'start', card: 'reward' })}>Request demo reward</button>
    {card.phase === 'complete' && <p>You can request another reward by starting a new request.</p>}
    {allowedFor(view, { type: 'new-operation', card: 'reward' }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'new-operation', card: 'reward' })}>Change reward amount</button>}
  </div>;
}
