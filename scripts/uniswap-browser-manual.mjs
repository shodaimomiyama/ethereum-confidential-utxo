#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createServer } from 'vite';
let environment;
let stopRequested = false;
let stop;
const stopped = new Promise(resolve => { stop = resolve; });

function requestStop() {
  if (stopRequested) return;
  stopRequested = true;
  stop();
}

process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

async function rpc(method, params) {
  const response = await fetch(environment.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? response.status)}`);
  return body.result;
}

function printStatus() {
  console.log(`App: ${environment.appUrl}`);
  console.log(`Anvil RPC: ${environment.rpcUrl}`);
  console.log(`MetaMask custom network: Anvil local test / chain ID 31337 / RPC ${environment.rpcUrl} / ETH`);
  console.log(`Reward pool available: ${Number(environment.rewardAvailableWei) / 1e18} ETH`);
  console.log('Use a fresh MetaMask profile and a throwaway wallet. The HTTPS certificate is self-signed; accept it only for this local session.');
  console.log('After creating/importing that wallet, enter `fund 0xYOUR_WALLET_ADDRESS` here to set its public balance to 2 ETH.');
  console.log('Commands: fund 0x..., mine, status, help, quit. An empty line or Ctrl+C stops the environment.');
}

async function run() {
  let vite;
  let input;
  try {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
    const { startBrowserLiveEnvironment } = await vite.ssrLoadModule('/tests/integration/uniswap/browser-live-environment.ts');
    console.log('Starting disposable Anvil, Worker, and HTTPS site (about 30 seconds)...');
    environment = await startBrowserLiveEnvironment();
    if (stopRequested) return;
    printStatus();
    input = createInterface({ input: process.stdin, output: process.stdout });
    let pending = Promise.resolve();
    input.on('line', line => {
      pending = pending.then(async () => {
        if (stopRequested) return;
        const command = line.trim();
        if (!command || command === 'quit' || command === 'exit') {
          requestStop();
        } else if (command === 'help' || command === 'status') {
          printStatus();
        } else if (command === 'mine') {
          await rpc('evm_mine', []);
          console.log('Mined one local block.');
        } else if (command.startsWith('fund ')) {
          const address = command.slice(5).trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Enter a valid 0x wallet address.');
          await rpc('anvil_setBalance', [address, '0x1bc16d674ec80000']);
          console.log(`Set ${address} public balance to 2 ETH on the disposable chain.`);
        } else {
          console.log('Unknown command. Enter `help` for commands.');
        }
      }).catch(error => console.error(`Command failed: ${error.message}`));
    });
    input.on('close', requestStop);
    await stopped;
    input.close();
    await pending;
  } finally {
    input?.close();
    try { await environment?.close(); }
    finally { await vite?.close(); }
  }
}

run().catch(error => {
  console.error(`Manual environment failed: ${error.message}`);
  process.exitCode = 1;
});
