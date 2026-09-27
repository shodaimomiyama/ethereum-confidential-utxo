import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';

test('browser bundle imports the shared payment client without a Buffer global', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ecu-uniswap-browser-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        lib: {
          entry: resolve('packages/uniswap/src/index.ts'),
          formats: ['es'],
          fileName: () => 'payment-client.mjs',
        },
      },
    });
    const output = execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `globalThis.Buffer = undefined; const client = await import(${JSON.stringify(join(outDir, 'payment-client.mjs'))}); if (typeof client.encodePayCall !== 'function' || typeof client.createPaymentClient !== 'function') process.exit(1);`,
    ], { encoding: 'utf8' });
    if (output !== '') throw new Error(`unexpected browser bundle output: ${output}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
