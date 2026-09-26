import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const host = '127.0.0.1';
const port = 18545;
const url = `http://${host}:${port}`;

function portInUse() {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForAnvil(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Anvil exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(500),
      });
      const result = await response.json();
      if (result.result === '0x7a69') return;
      if (result.result) throw new Error(`unexpected chain ID: ${result.result}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('unexpected chain ID')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Anvil did not become ready on 127.0.0.1:18545 within 10 seconds');
}

if (await portInUse()) throw new Error('127.0.0.1:18545 is already in use; stop that process before the smoke test');
const child = spawn('anvil', ['--silent', '--host', host, '--port', String(port), '--hardfork', 'cancun', '--chain-id', '31337'], { stdio: 'ignore' });
try {
  await waitForAnvil(child);
  const test = spawn('pnpm', ['exec', 'vitest', 'run', 'tests/environment/environment-smoke.test.ts'], { stdio: 'inherit' });
  const exitCode = await new Promise((resolve, reject) => {
    test.once('error', reject);
    test.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  child.kill('SIGTERM');
}
