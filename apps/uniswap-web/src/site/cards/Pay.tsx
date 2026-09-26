import { allowedFor } from '../../contracts/controller.js';
import type { UiController } from '../../contracts/controller.js';
import type { CardState, ViewState } from '../../contracts/state.js';
import { formatEth, formatUtc } from '../format.js';
import { CardFeedback } from './CardFeedback.js';

function quoteDetails(quote: NonNullable<CardState['quote']>) {
  return <dl className="terms-list"><div><dt>Estimated output</dt><dd>{formatEth(quote.quoteOut)} dUSD</dd></div>
    <div><dt>Minimum output</dt><dd>{formatEth(quote.minAmountOut)} dUSD</dd></div>
    <div><dt>Deadline</dt><dd>{formatUtc(quote.deadline)}</dd></div></dl>;
}

export function Pay({ view, controller }: { readonly view: ViewState; readonly controller: UiController }) {
  const card = view.cards.pay;
  const editable = allowedFor(view, { type: 'edit', card: 'pay', field: 'amount', value: '' });
  const selected = view.selectedInput.pay;
  return <div className="card-form">
    <h2>Pay privately</h2>
    <p>Spend one private ETH UTXO. Its remaining value returns as a private change UTXO after receipt verification.</p>
    <label htmlFor="pay-amount">Pay amount in ETH</label>
    <input id="pay-amount" type="text" inputMode="decimal" autoComplete="off" value={card.input.amount ?? ''} disabled={!editable}
      onChange={(event) => void controller.dispatch({ type: 'edit', card: 'pay', field: 'amount', value: event.target.value })} />
    <div className="field-heading"><label htmlFor="pay-recipient">Recipient address</label><button type="button" className="text-button" disabled={!editable || !view.currentScope} onClick={() => { if (view.currentScope) void controller.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: view.currentScope.owner }); }}>Use my address</button></div>
    <input id="pay-recipient" type="text" autoComplete="off" spellCheck={false} value={card.input.recipient ?? ''} disabled={!editable}
      onChange={(event) => void controller.dispatch({ type: 'edit', card: 'pay', field: 'recipient', value: event.target.value })} />
    {selected && <div className="conditions"><p>Selected UTXO: <code title={selected.id}>{selected.id}</code></p>
      <p>{formatEth(selected.amountWei)} ETH input; {formatEth(selected.changeWei)} ETH private change after payment and receipt.</p></div>}
    {card.quote && <section className="conditions" aria-label="Payment terms"><h3>Current terms</h3>{quoteDetails(card.quote)}
      {editable && <><label htmlFor="pay-min">Minimum output in dUSD</label><input id="pay-min" type="text" inputMode="decimal" value={card.input.minAmountOut ?? formatEth(card.quote.minAmountOut)} disabled={!editable}
        onChange={(event) => void controller.dispatch({ type: 'edit', card: 'pay', field: 'minAmountOut', value: event.target.value })} />
        <label htmlFor="pay-deadline">Deadline (UTC timestamp)</label><input id="pay-deadline" type="text" inputMode="numeric" value={card.input.deadline ?? String(card.quote.deadline)} disabled={!editable}
          onChange={(event) => void controller.dispatch({ type: 'edit', card: 'pay', field: 'deadline', value: event.target.value })} /></>}
    </section>}
    {card.phase === 'confirm-terms' && <section className="conditions" aria-label="Changed terms"><h3>Terms changed</h3>
      {card.quote && <><h4>Previous terms</h4>{quoteDetails(card.quote)}</>}
      {card.proposedQuote && <><h4>New terms</h4>{quoteDetails(card.proposedQuote)}</>}
      <button type="button" className="button primary" disabled={!allowedFor(view, { type: 'confirm-terms', card: 'pay' })}
        onClick={() => void controller.dispatch({ type: 'confirm-terms', card: 'pay' })}>Confirm new terms</button>
    </section>}
    <CardFeedback card={card} blockedReason={view.reasons['start:pay']} />
    <button type="button" className="button primary" disabled={!allowedFor(view, { type: 'start', card: 'pay' })}
      onClick={() => void controller.dispatch({ type: 'start', card: 'pay' })}>Start private payment</button>
    {allowedFor(view, { type: 'new-operation', card: 'pay' }) && <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'new-operation', card: 'pay' })}>New payment</button>}
  </div>;
}
