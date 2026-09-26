import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = 'vendor/uniswap-v2';

function sourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.sol') || entry.name === 'LICENSE.txt') {
        files.push(relative(root, path));
      }
    }
  }
  for (const name of ['core', 'periphery', 'lib']) {
    if (existsSync(join(root, name))) walk(join(root, name));
  }
  return files.sort();
}

export function verifyUniswapSources(root, lock) {
  const expected = Object.keys(lock?.files ?? {}).sort();
  const actual = sourceFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('source file list mismatch or source missing');
  }
  for (const path of expected) {
    const digest = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    if (digest !== lock.files[path]) throw new Error(`source ${path} hash mismatch`);
  }
  if (!lock?.upstream || !lock?.localPatch || !lock?.compilers) {
    throw new Error('source provenance missing');
  }
}

export function fetchUniswapSources(root, lock) {
  for (const name of ['core', 'periphery', 'lib']) {
    if (existsSync(join(root, name))) throw new Error(`source ${name} already exists`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'fixed-uniswap-v2-'));
  try {
    for (const name of ['core', 'periphery', 'lib']) {
      const { url, commit } = lock.upstream[name];
      const checkout = join(scratch, name);
      execFileSync('git', ['clone', '--quiet', url, checkout]);
      execFileSync('git', ['-C', checkout, 'checkout', '--quiet', commit]);
      cpSync(join(checkout, 'contracts'), join(root, name, 'contracts'), { recursive: true });
      cpSync(join(checkout, 'LICENSE'), join(root, name, 'LICENSE.txt'));
    }
    const patch = lock.localPatch;
    const path = join(root, patch.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(patch.before.slice(2)) || source.includes(patch.after.slice(2))) {
      throw new Error('source patch preimage mismatch');
    }
    writeFileSync(path, source.replace(patch.before.slice(2), patch.after.slice(2)));
    verifyUniswapSources(root, lock);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const root = resolve(process.argv[3] ?? defaultRoot);
  const lock = JSON.parse(readFileSync(join(root, 'source-lock.json'), 'utf8'));
  if (action === 'verify') verifyUniswapSources(root, lock);
  else if (action === 'fetch') fetchUniswapSources(root, lock);
  else throw new Error('usage: node scripts/uniswap-source.mjs verify|fetch [root]');
  console.log(`Uniswap source ${action}: ${root}`);
}
