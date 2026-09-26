#!/usr/bin/env node
// Fresh setup timing using the same commands and order as ../../setup.sh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const here = import.meta.dirname;
const bench = path.resolve(here, '../..');
const checkout = process.argv[2] ?? '/tmp/eip8182-setup-timing-fresh';
const commit = '639baaf7b29c22eb43ba6150140902ea8dbbbc46';
const logPath = path.join(here, 'setup.log');
const steps = [];
const started = performance.now();
const log = fs.openSync(logPath, 'w');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (name, command, args, cwd = checkout) => new Promise((resolve, reject) => {
  fs.writeSync(log, `\n== ${name}: ${command} ${args.join(' ')} ==\n`);
  const start = performance.now();
  const child = spawn(command, args, { cwd, stdio: ['ignore', log, log] });
  child.on('error', reject);
  child.on('close', (code) => {
    const item = { name, command, args, wallMs: performance.now() - start, exitCode: code };
    steps.push(item);
    code === 0 ? resolve(item) : reject(new Error(`${name} failed with exit ${code}`));
  });
});
const result = {
  classification: 'additional fresh setup timing; excluded from three formal operation trials',
  sourceCommit: commit,
  setupScriptSha256: sha256(path.join(bench, 'setup.sh')),
  checkout,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpuModel: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  toolVersions: {
    node: process.version,
    npm: spawnSync('npm', ['--version'], {encoding: 'utf8'}).stdout.trim(),
    forge: spawnSync('forge', ['--version'], {encoding: 'utf8'}).stdout.trim().split('\n')[0],
    circom: 'vendored upstream vendor/circom 2.2.3'
  },
  steps,
  success: false
};
try {
  if (fs.existsSync(checkout)) throw new Error(`checkout already exists: ${checkout}`);
  await run('clone', 'git', ['clone', 'https://github.com/0xFacet/eip-8182-reference-implementation.git', checkout], '/tmp');
  await run('checkout_pinned_commit', 'git', ['checkout', '--detach', commit]);
  await run('submodules', 'git', ['submodule', 'update', '--init', '--recursive']);
  await run('npm_root_lockfile', 'npm', ['ci']);
  await run('npm_missing_upstream_dependency', 'npm', ['install', '--no-save', 'ethereum-cryptography@2.2.1']);
  fs.mkdirSync(path.join(checkout, 'build/pool'), { recursive: true });
  await run('domain_tags', 'node', ['scripts/circom/gen_domain_tags.js']);
  await run('pool_circuit_compile', path.join(checkout, 'vendor/circom'), ['circuits/pool/pool.circom', '-l', 'circuits/common', '-l', 'circuits/pool', '--r1cs', '--wasm', '--sym', '--O2', '-o', 'build/pool']);
  fs.copyFileSync(path.join(checkout, 'sepolia-demo/prover-assets/pool_final.zkey'), path.join(checkout, 'build/pool/pool_final.zkey'));
  fs.copyFileSync(path.join(checkout, 'sepolia-demo/prover-assets/pool_vkey.json'), path.join(checkout, 'build/pool/pool_vkey.json'));
  await run('auth_dev_ptau_new', path.join(checkout, 'node_modules/.bin/snarkjs'), ['powersoftau', 'new', 'bn128', '12', 'build/pot12_0000.ptau']);
  await run('auth_dev_ptau_contribute', path.join(checkout, 'node_modules/.bin/snarkjs'), ['powersoftau', 'contribute', 'build/pot12_0000.ptau', 'build/pot12_0001.ptau', '--name=issue10-local-dev', '-e=issue10-local-dev']);
  await run('auth_dev_ptau_phase2', path.join(checkout, 'node_modules/.bin/snarkjs'), ['powersoftau', 'prepare', 'phase2', 'build/pot12_0001.ptau', 'build/pot12_final.ptau']);
  await run('auth_demo_build', 'bash', ['scripts/circuit/build_auth_demo.sh']);
  await run('delivery_input_patch_check', 'git', ['apply', '--check', path.join(bench, 'output-note-data.patch')]);
  await run('delivery_input_patch', 'git', ['apply', path.join(bench, 'output-note-data.patch')]);
  await run('forge_build', 'forge', ['build']);
  await run('npm_sepolia_demo_lockfile', 'npm', ['ci', '--ignore-scripts'], path.join(checkout, 'sepolia-demo'));
  await run('sepolia_sdk_build', 'npm', ['run', 'build:sdk'], path.join(checkout, 'sepolia-demo'));
  result.success = true;
} catch (error) {
  result.error = String(error);
} finally {
  result.totalWallMs = performance.now() - started;
  if (fs.existsSync(path.join(checkout, '.git'))) {
    result.checkedOutCommit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: checkout, encoding: 'utf8'}).stdout.trim();
  }
  result.assetHashes = {};
  for (const file of ['build/pool/pool_final.zkey', 'build/pool/pool_js/pool.wasm', 'build/auth_demo/auth_demo_final.zkey', 'build/auth_demo/auth_demo_vkey.json']) {
    const absolute = path.join(checkout, file);
    if (fs.existsSync(absolute)) result.assetHashes[file] = sha256(absolute);
  }
  fs.writeFileSync(path.join(here, 'setup-timing.json'), JSON.stringify(result, null, 2) + '\n');
  fs.closeSync(log);
}
if (!result.success) process.exitCode = 1;
