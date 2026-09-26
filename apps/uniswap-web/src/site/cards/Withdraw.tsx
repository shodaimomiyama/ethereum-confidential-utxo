import { allowedFor } from '../../contracts/controller.js';
import type { UiController } from '../../contracts/controller.js';
import type { ViewState } from '../../contracts/state.js';
import { formatEth } from '../format.js';
import { CardFeedback } from './CardFeedback.js';

export function Withdraw({ view, controller }: { readonly view: ViewState; readonly controller: UiController }) {
  const card = view.cards.withdraw;
  const selected = view.selectedInput.withdraw;
  return <div className="card-form">
    <h2>Withdraw</h2>
    <p>Withdraw one private UTXO in full to your connected public address.</p>
    <label htmlFor="withdraw-utxo">UTXO to withdraw</label>
    <select id="withdraw-utxo" value={card.input.utxoId ?? ''} disabled={!allowedFor(view, { type: 'edit', card: 'withdraw', field: 'utxoId', value: '' })}
      onChange={(event) => void controller.dispatch({ type: 'edit', card: 'withdraw', field: 'utxoId', value: event.target.value })}>
      <option value="">Select a private UTXO</option>
      {view.utxos.filter((item) => item.available).map((item) => <option value={item.id} key={item.id}>{formatEth(item.amountWei)} ETH — {item.id}</option>)}
    </select>
    {selected && <p className="conditions">The full {formatEth(selected.amountWei)} ETH UTXO will be withdrawn. The destination and withdrawn amount become publicly visible. No private change is returned.</p>}
    <CardFeedback card={card} blockedReason={view.reasons['start:withdraw']} />
    <button type="button" className="button primary" disabled={!allowedFor(view, { type: 'start', card: 'withdraw' })}
      onClick={() => void controller.dispatch({ type: 'start', card: 'withdraw' })}>Withdraw full UTXO</button>
    {allowedFor(view, { type: 'new-operation', card: 'withdraw' }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'new-operation', card: 'withdraw' })}>New withdrawal</button>}
  </div>;
}
