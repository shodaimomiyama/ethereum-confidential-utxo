export function mockTransactionDetail(hash: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
    ? `Simulated transaction ${hash}. This is a local example, not an on-chain transaction.`
    : 'Invalid simulated transaction identifier.';
}

export function MockTransactionPage({ hash }: { readonly hash: string }) {
  return <div className="site"><header className="site-header"><a className="brand" href="/app">Dim</a><a href="/app">Back to app</a></header>
    <main className="transaction-page surface"><h1>Simulated transaction</h1><p>{mockTransactionDetail(hash)}</p></main></div>;
}
