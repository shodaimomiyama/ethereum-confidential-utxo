import type { SiteConfig } from './config.js';

export function Introduction({ config }: { readonly config: SiteConfig }) {
  return <div className="site introduction">
    <header className="site-header">
      <a className="brand" href="/" aria-label="Dim home">
        <img src="/assets/brand/dim-logo.png" width="54" height="54" alt="" />
        <span>Dim</span>
      </a>
      <nav aria-label="Main"><a href="/app">Try demo</a></nav>
    </header>
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Ethereum Sepolia research demo</p>
          <h1 id="hero-title">Dim</h1>
          <p className="tagline">Lightweight privacy for amounts on Ethereum.</p>
          <p>Receive private ETH rewards, exchange a chosen part through public Uniswap liquidity, and keep the remainder in a private UTXO.</p>
          <a className="button primary" href="/app">Try demo</a>
        </div>
        <img className="hero-art" src="/assets/brand/dim-cover.png" width="1672" height="941" alt="Dim mark over a blue horizon" />
      </section>
      <section className="content-grid" aria-label="How Dim works">
        <article className="surface"><span className="step">01</span><h2>Receive</h2><p>A demo distributor sends a private ETH reward. The distributor knows the amount it sends.</p></article>
        <article className="surface"><span className="step">02</span><h2>Pay</h2><p>Choose how much ETH to exchange for Demo USD (dUSD). The full token output goes to your recipient.</p></article>
        <article className="surface"><span className="step">03</span><h2>Keep or withdraw</h2><p>The unused ETH remains in a private UTXO. You can later withdraw one UTXO in full to your wallet.</p></article>
      </section>
      <section className="explanation surface" aria-labelledby="privacy-title">
        <h2 id="privacy-title">What stays visible</h2>
        <p>The public transaction graph, the payment ETH amount, output token and amount, and recipient are visible. Dim does not hide wallet ownership or transaction senders.</p>
        <p>A public deposit followed by a partial payment can reveal the remaining amount by subtraction. A private reward gives a different example, but its distributor knows the original amount and privacy depends on the full history. A later full withdrawal can reveal earlier amounts.</p>
        <p>dUSD is a demo token. It has no redemption or stable-price promise. This site is a research testnet demonstration.</p>
      </section>
      <section className="evidence surface" aria-label="Check the work">
        <h2>Check the work</h2>
        <p>Explore the source and the evidence available for this version. Simulated operations are not evidence of real asset movement.</p>
        {config.codeUrl && <a href={config.codeUrl}>View code</a>}
        {config.evidenceUrl && <a href={config.evidenceUrl}>View published results</a>}
        {!config.evidenceUrl && <p>Verification results are not yet published.</p>}
      </section>
    </main>
    <footer>Dim · Research prototype on Ethereum Sepolia</footer>
  </div>;
}
