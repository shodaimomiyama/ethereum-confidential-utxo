import type { SiteConfig } from './config.js';

export function Introduction({ config }: { readonly config: SiteConfig }) {
  return <div className="site introduction">
    <header className="site-header">
      <a className="brand" href="/" aria-label="Dim home">
        <img src="/assets/brand/dim-logo.png" width="54" height="54" alt="" />
        <span>Dim</span>
      </a>
      <nav aria-label="Main"><a className="header-cta" href="/app">Try demo <span aria-hidden="true">↗</span></a></nav>
    </header>
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <img className="hero-art" src="/assets/brand/dim-cover.png" width="1672" height="941" alt="Dim mark over a blue horizon" />
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-line" aria-hidden="true" /> Ethereum Sepolia research demo</p>
          <h1 id="hero-title">Dim</h1>
          <p className="tagline">Lightweight privacy for amounts on Ethereum.</p>
          <p className="hero-description">Receive private ETH rewards, exchange a chosen part through public Uniswap liquidity, and keep the remainder in a private UTXO.</p>
          <a className="button primary hero-cta" href="/app">Try demo <span aria-hidden="true">↗</span></a>
        </div>
        <div className="hero-caption" aria-hidden="true"><span>DIM / 01</span><span>RESEARCH PROTOTYPE</span></div>
      </section>
      <section className="journey" aria-labelledby="journey-title">
        <div className="section-intro">
          <p className="eyebrow">The experience</p>
          <h2 id="journey-title">A simple path through private value.</h2>
        </div>
        <div className="content-grid">
          <article className="journey-step"><span className="step">01 / RECEIVE</span><h3>Receive</h3><p>A demo distributor sends a private ETH reward. The distributor knows the amount it sends.</p></article>
          <article className="journey-step"><span className="step">02 / PAY</span><h3>Pay</h3><p>Choose how much ETH to exchange for Demo USD (dUSD). The full token output goes to your recipient.</p></article>
          <article className="journey-step"><span className="step">03 / KEEP</span><h3>Keep or withdraw</h3><p>The unused ETH remains in a private UTXO. You can later withdraw one UTXO in full to your wallet.</p></article>
        </div>
      </section>
      <section className="explanation" aria-labelledby="privacy-title">
        <div className="explanation-heading">
          <p className="eyebrow">Understand the boundary</p>
          <h2 id="privacy-title">What stays visible</h2>
          <span className="explanation-rule" aria-hidden="true" />
          <p>Privacy depends on the full history of a payment, including what happens before and after it.</p>
        </div>
        <div className="explanation-details">
          <div className="disclosure"><span className="disclosure-number">01</span><p>The public transaction graph, the payment ETH amount, output token and amount, and recipient are visible. Dim does not hide wallet ownership or transaction senders.</p></div>
          <div className="disclosure"><span className="disclosure-number">02</span><p>A public deposit followed by a partial payment can reveal the remaining amount by subtraction. A private reward gives a different example, but its distributor knows the original amount and privacy depends on the full history. A later full withdrawal can reveal earlier amounts.</p></div>
          <div className="disclosure"><span className="disclosure-number">03</span><p>dUSD is a demo token. It has no redemption or stable-price promise. This site is a research testnet demonstration.</p></div>
        </div>
      </section>
      <section className="evidence" aria-labelledby="evidence-title">
        <div>
          <p className="eyebrow">Open research</p>
          <h2 id="evidence-title">Check the work.</h2>
          <p>Explore the source and the evidence available for this version. Simulated operations are not evidence of real asset movement.</p>
          {!config.evidenceUrl && <p className="evidence-note">Verification results are not yet published.</p>}
        </div>
        <div className="evidence-links">
          {config.codeUrl && <a href={config.codeUrl}>View code <span aria-hidden="true">↗</span></a>}
          {config.evidenceUrl && <a href={config.evidenceUrl}>View published results <span aria-hidden="true">↗</span></a>}
          <a href="/app">Try demo <span aria-hidden="true">↗</span></a>
        </div>
      </section>
    </main>
    <footer><span>Dim</span><span>Research prototype on Ethereum Sepolia</span></footer>
  </div>;
}
