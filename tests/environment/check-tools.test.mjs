import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const target = resolve('scripts/check-tools.mjs');

function runWithVersions(versions) {
  const directory = mkdtempSync(join(tmpdir(), 'utxo-tools-'));
  try {
    for (const [name, version] of Object.entries(versions)) {
      const path = join(directory, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
      chmodSync(path, 0o755);
    }
    return spawnSync(process.execPath, [target], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const good = { pnpm: '10.34.5', forge: 'forge Version: 1.8.3', cast: 'cast Version: 1.8.3', anvil: 'anvil Version: 1.8.3' };

test('accepts the fixed tool versions', () => {
  const result = runWithVersions(good);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a different pnpm version with an actionable message', () => {
  const result = runWithVersions({ ...good, pnpm: '10.32.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pnpm.*10\.34\.5.*10\.32\.0/);
});

test('rejects a different Foundry version', () => {
  const result = runWithVersions({ ...good, forge: 'forge Version: 1.7.1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forge.*1\.8\.3.*1\.7\.1/);
});
