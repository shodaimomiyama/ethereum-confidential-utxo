import { useState } from 'react';
import type { UiController } from '../contracts/controller.js';
import type { Card } from '../contracts/state.js';
import type { SiteConfig } from './config.js';
import { ControllerProvider, useViewState } from './controller-context.js';
import { formatEth } from './format.js';

const tabs: readonly { key: Card; label: string }[] = [
  { key: 'reward', label: 'Demo reward' },
  { key: 'pay', label: 'Pay' },
  { key: 'deposit', label: 'Deposit' },
  { key: 'withdraw', label: 'Withdraw' },
];

function AppShell({ config }: { readonly config: SiteConfig }) {
  const view = useViewState();
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
      <section className="card-shell surface" aria-label="Dim actions">
        <div role="tablist" aria-label="Choose an action" className="card-tabs">
          {tabs.map((tab) => <button key={tab.key} id={`tab-${tab.key}`} role="tab" aria-controls={`panel-${tab.key}`} aria-selected={active === tab.key} tabIndex={active === tab.key ? 0 : -1} type="button" onClick={() => setActive(tab.key)}>{tab.label}</button>)}
        </div>
        <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} className="card-content">
          <h2>{tabs.find((tab) => tab.key === active)?.label}</h2>
        </div>
      </section>
      <aside className="surface"><h2>Activity</h2><p>Ongoing operations and their results appear here.</p><p>Full history: Coming soon</p></aside>
    </main>
  </div>;
}

export function AppPage({ controller, config }: { readonly controller: UiController; readonly config: SiteConfig }) {
  return <ControllerProvider controller={controller}><AppShell config={config} /></ControllerProvider>;
}
