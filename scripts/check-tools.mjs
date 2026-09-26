import { execFileSync } from 'node:child_process';

let failed = false;
const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex === -1 ? 'macos-arm64' : process.argv[profileIndex + 1];
if (!['macos-arm64', 'github-macos-arm64'].includes(profile)) {
  console.error(`unsupported tool profile: ${profile ?? 'missing'}`);
  failed = true;
}

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

const expectedPlatform = { 'macos-arm64': ['darwin', 'arm64'],
  'github-macos-arm64': ['darwin', 'arm64'] }[profile];
if (expectedPlatform && (process.platform !== expectedPlatform[0] || process.arch !== expectedPlatform[1])) {
  console.error(`platform: expected ${expectedPlatform.join(' ')}, found ${process.platform} ${process.arch}`);
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
else console.log(`Tool versions match the ${profile} setup profile.`);
