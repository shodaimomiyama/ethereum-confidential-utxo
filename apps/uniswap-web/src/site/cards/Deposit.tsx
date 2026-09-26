import { allowedFor } from '../../contracts/controller.js';
import type { UiController } from '../../contracts/controller.js';
import type { ViewState } from '../../contracts/state.js';
import { CardFeedback } from './CardFeedback.js';

export function Deposit({ view, controller }: { readonly view: ViewState; readonly controller: UiController }) {
  const card = view.cards.deposit;
  return <div className="card-form">
    <h2>Deposit</h2>
    <p>Convert public test ETH into a private UTXO. Transaction gas is paid separately from your public ETH balance.</p>
    <label htmlFor="deposit-amount">Deposit amount in ETH</label>
    <input id="deposit-amount" type="text" inputMode="decimal" autoComplete="off" value={card.input.amount ?? ''}
      disabled={!allowedFor(view, { type: 'edit', card: 'deposit', field: 'amount', value: '' })}
      onChange={(event) => void controller.dispatch({ type: 'edit', card: 'deposit', field: 'amount', value: event.target.value })} />
    <p className="muted">Confirm the amount and gas separately in your wallet. Private balance becomes available only after receipt verification.</p>
    <CardFeedback card={card} blockedReason={view.reasons['start:deposit']} />
    <button type="button" className="button primary" disabled={!allowedFor(view, { type: 'start', card: 'deposit' })}
      onClick={() => void controller.dispatch({ type: 'start', card: 'deposit' })}>Start deposit</button>
  </div>;
}
