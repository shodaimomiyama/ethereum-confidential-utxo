import { readFileSync, writeFileSync } from 'node:fs';

const source = 'packages/ethereum/generated/uniswap-payment-v1.json';
const output = 'packages/uniswap/src/generated/adapter-abi.ts';
const artifact = JSON.parse(readFileSync(source, 'utf8'));
if (artifact.schemaVersion !== 1 || !Array.isArray(artifact.abi)
  || typeof artifact.manifest?.abiSha256 !== 'string'
  || !artifact.abi.some((item) => item.type === 'function' && item.name === 'pay')) {
  throw new Error('invalid generated Uniswap payment artifact');
}
const rendered = `// Generated from ${source}; ABI SHA-256: ${artifact.manifest.abiSha256}\n`
  + `import type { Abi } from 'viem';\n\n`
  + `export const adapterAbi = ${JSON.stringify(artifact.abi, null, 2)} as const satisfies Abi;\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== rendered) throw new Error('Uniswap client ABI differs from generated artifact');
} else {
  writeFileSync(output, rendered);
}
