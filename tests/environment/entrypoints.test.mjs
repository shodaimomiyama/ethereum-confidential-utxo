import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const script of process.env.UTXO_ENTRYPOINT_PROBE ? [] : ['test', 'smoke:rpc']) {
  test(`${script} rejects Foundry 1.7.1 before running`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'utxo-wrong-forge-'));
    try {
      const forge = join(dir, 'forge');
      writeFileSync(forge, '#!/bin/sh\necho "forge Version: 1.7.1"\n');
      chmodSync(forge, 0o755);
      let output = '';
      let failed = false;
      try {
        execFileSync('pnpm', [script], {
          cwd: process.cwd(),
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, UTXO_ENTRYPOINT_PROBE: '1' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20000,
        });
      } catch (error) {
        failed = true;
        output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      }
      assert.equal(failed, true);
      assert.match(output, /forge: expected 1\.8\.3, found 1\.7\.1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
