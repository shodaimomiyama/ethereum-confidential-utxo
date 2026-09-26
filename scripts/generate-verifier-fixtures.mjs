import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = 'experiments/design/crypto-profile-v3/exp08/parameters.json';
const target = 'contracts/test/fixtures/VerifierVectors.sol';
const params = JSON.parse(readFileSync(source, 'utf8'));
const word = value => BigInt(value).toString(10);
if (params.base.length !== 4 || params.gs.length !== 128 || params.hs.length !== 128) {
  throw new Error('parameter shape');
}

const lines = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity 0.8.37;',
  '',
  'library VerifierVectors {',
  '    function parameters() internal pure returns (',
  '        uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs',
  '    ) {',
];
for (const [name, values] of [['base', params.base], ['gs', params.gs], ['hs', params.hs]]) {
  for (let i = 0; i < values.length; i++) lines.push(`        ${name}[${i}] = ${word(values[i])};`);
}
lines.push('    }', '}', '');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, lines.join('\n'));
execFileSync('forge', ['fmt', '--root', 'contracts', target]);
console.log(`Wrote ${target} from ${source}`);
