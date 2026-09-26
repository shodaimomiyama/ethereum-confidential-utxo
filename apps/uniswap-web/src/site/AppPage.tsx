import { useState } from 'react';
import type { UiController } from '../contracts/controller.js';
import type { Card } from '../contracts/state.js';
import type { SiteConfig } from './config.js';
import { ControllerProvider, useController, useViewState } from './controller-context.js';
import { formatEth } from './format.js';
import { Preparation } from './Preparation.js';
import { OperationStatus } from './OperationStatus.js';
import { Reward } from './cards/Reward.js';
import { Pay } from './cards/Pay.js';
import { Deposit } from './cards/Deposit.js';
import { Withdraw } from './cards/Withdraw.js';

const tabs: readonly { key: Card; label: string }[] = [
  { key: 'reward', label: 'Demo reward' },
  { key: 'pay', label: 'Pay' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'withdraw', label: 'Withdraw' },
];

function AppShell({ config }: { readonly config: SiteConfig }) {
  const view = useViewState();
  const controller = useController();
  const [active, setActive] = useState<Card>('reward');
  return <div className="site app-page">
    <header className="site-header">
      <a className="brand" href="/" aria-label="Dim home"><img src="/assets/brand/dim-logo.png" width="48" height="48" alt="" /><span>Dim</span></a>
      <a href="/">About Dim</a>
    </header>
    <main className="app-layout">
      <div className="app-intro"><p className="eyebrow">{config.mode === 'mock' ? 'Simulated demo' : 'Ethereum Sepolia'}</p><h1>Try Dim</h1><p>Start with a private demo reward, or deposit test ETH from your wallet.</p></div>
      <section className="balances" aria-label="Balances">
        <div className="surface"><span>Public ETH</span><strong>{formatEth(view.publicEthWei)} ETH</strong></div>
        <div className="surface"><span>Available private ETH</span><strong>{formatEth(view.availablePrivateWei)} ETH</strong></div>
      </section>
      <Preparation view={view} controller={controller} config={config} />
      <section className="card-shell surface" aria-label="Dim actions">
        <div role="tablist" aria-label="Choose an action" className="card-tabs">
          {tabs.map((tab) => <button key={tab.key} id={`tab-${tab.key}`} role="tab" aria-controls={`panel-${tab.key}`} aria-selected={active === tab.key} tabIndex={active === tab.key ? 0 : -1} type="button" onClick={() => setActive(tab.key)}>{tab.label}</button>)}
        </div>
        <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} className="card-content">
          {active === 'reward' && <Reward view={view} controller={controller} />}
          {active === 'pay' && <Pay view={view} controller={controller} />}
          {active === 'deposit' && <Deposit view={view} controller={controller} />}
          {active === 'withdraw' && <Withdraw view={view} controller={controller} />}
        </div>
      </section>
      <OperationStatus view={view} controller={controller} config={config} />
    </main>
  </div>;
}

export function AppPage({ controller, config }: { readonly controller: UiController; readonly config: SiteConfig }) {
  return <ControllerProvider controller={controller}><AppShell config={config} /></ControllerProvider>;
}
