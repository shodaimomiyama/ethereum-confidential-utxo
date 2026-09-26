import { execFileSync } from 'node:child_process';

let failed = false;

function requireVersion(tool, expected, parse = (value) => value.trim()) {
  let actual;
  try {
    actual = parse(execFileSync(tool, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    actual = 'not available';
  }
  if (actual !== expected) {
    console.error(`${tool}: expected ${expected}, found ${actual}`);
    failed = true;
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`platform: expected darwin arm64, found ${process.platform} ${process.arch}`);
  failed = true;
}
if (process.version !== 'v24.21.0') {
  console.error(`node: expected v24.21.0, found ${process.version}`);
  failed = true;
}
requireVersion('pnpm', '10.34.5');
if (!process.argv.includes('--no-foundry')) {
  for (const tool of ['forge', 'cast', 'anvil']) {
    requireVersion(tool, '1.8.3', (value) => value.match(/\bVersion:\s*(\d+\.\d+\.\d+)\b/)?.[1] ?? value.trim());
  }
}
if (failed) process.exitCode = 1;
else console.log('Tool versions match the macOS ARM64 setup profile.');
