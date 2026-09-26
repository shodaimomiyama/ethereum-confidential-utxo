import type { UiController } from '../contracts/controller.js';
import type { ViewState } from '../contracts/state.js';
import type { SiteConfig } from './config.js';
import { formatUtc } from './format.js';

export function Preparation({ view, controller, config }: {
  readonly view: ViewState; readonly controller: UiController; readonly config: SiteConfig;
}) {
  const prep = view.preparation;
  const action = !prep.wallet ? { type: 'connect-wallet' as const, label: config.mode === 'mock' ? 'Connect simulated wallet' : 'Connect wallet', detail: 'Connect a wallet to begin.' }
    : !prep.network ? { type: 'switch-network' as const, label: 'Switch to Sepolia', detail: 'Select the supported test network.' }
      : !prep.key ? { type: 'prepare-recipient-key' as const, label: 'Prepare privacy key', detail: 'A dedicated wallet approval will prepare your private receipt key.' }
        : !prep.faucet || !prep.gas ? { type: 'refresh-balances' as const, label: 'Recheck public balance', detail: 'Get test ETH and keep some public ETH for gas.' }
          : undefined;

  return <section className="preparation surface" aria-label="Preparation">
    <div className="section-heading"><h2>Before you start</h2><span className="status-chip">{action ? 'Setup needed' : 'Ready to use'}</span></div>
    <p>{action?.detail ?? (config.mode === 'mock'
      ? 'Your wallet, network, key and test ETH are ready in this simulation.'
      : 'Your wallet, network, key and test ETH are ready.')}</p>
    {view.currentScope && <p className="address-line">Wallet: <span title={view.currentScope.owner}>{view.currentScope.owner}</span></p>}
    <p>Network: {prep.network ? 'Ethereum Sepolia' : 'Not selected'}</p>
    {action && <button type="button" className="button primary" onClick={() => void controller.dispatch({ type: action.type })}>{action.label}</button>}
    {prep.wallet && prep.network && prep.key && (!prep.faucet || !prep.gas) && config.faucetUrl && <p><a href={config.faucetUrl} target="_blank" rel="noreferrer">Get test ETH</a> from an external faucet. Keep ETH for transaction gas.</p>}
    {view.checkedAt !== undefined && <p className="muted">Last checked: {formatUtc(view.checkedAt / 1000)}</p>}
    {view.isStale && <p role="status">Balance information may be out of date. Recheck before starting another operation.</p>}
    <button type="button" className="text-button" onClick={() => void controller.dispatch({ type: 'resync' })}>Resync private balance</button>
  </section>;
}
