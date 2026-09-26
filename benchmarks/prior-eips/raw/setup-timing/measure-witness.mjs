#!/usr/bin/env node
// Additional single-shot witness process timing, separate from formal trials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const ref = process.argv[2] ?? '/tmp/eip8182-clean-replay';
const here = import.meta.dirname;
const entries = [
  ['pool', 'build/pool/pool_js/generate_witness.js', 'build/pool/pool_js/pool.wasm', 'build/pool/input.json'],
  ['auth_demo', 'build/auth_demo/auth_demo_js/generate_witness.js', 'build/auth_demo/auth_demo_js/auth_demo.wasm', 'build/auth_demo/input.json']
];
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = entries.map(([name, generator, wasm, input]) => {
  const output = path.join('/tmp', `issue10-${name}-witness-timing.wtns`);
  const args = [generator, wasm, input, output];
  const start = performance.now();
  const result = spawnSync('node', args, { cwd: ref, encoding: 'utf8' });
  const wallMs = performance.now() - start;
  return { name, command: `node ${args.join(' ')}`, wallMs, exitCode: result.status,
    inputSha256: sha256(path.join(ref, input)), wasmSha256: sha256(path.join(ref, wasm)),
    outputBytes: fs.existsSync(output) ? fs.statSync(output).size : null,
    stderr: result.stderr.trim() };
});
const report = {
  classification: 'additional single-shot process timing, excluded from three formal operation trials',
  scope: 'Each wall time covers Node process startup, WASM loading, witness computation, and witness file write. It excludes witness input construction and proof generation.',
  reference: ref,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  rows
};
fs.writeFileSync(path.join(here, 'witness-timing.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (rows.some(row => row.exitCode !== 0)) process.exitCode = 1;
