import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = 'experiments/design/crypto-profile-v3/exp08/parameters.json';
const target = 'contracts/test/fixtures/VerifierVectors.sol';
const params = JSON.parse(readFileSync(source, 'utf8'));
const rangeCases = [
  ...JSON.parse(readFileSync('tests/vectors/cases/range-v3.json', 'utf8')).slice(0, 4),
  ...JSON.parse(readFileSync('tests/vectors/cases/range-deterministic.json', 'utf8')),
];
const trace = rangeCases[4].input.transcriptTrace;
const balanceCases = JSON.parse(readFileSync('tests/vectors/cases/balance.json', 'utf8'));
const abiCases = JSON.parse(readFileSync('tests/vectors/cases/verifier-abi.json', 'utf8'));
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
lines.push('    }', '');
lines.push('    function rangeProof(uint256 index) internal pure returns (');
lines.push('        bytes32 operationId, uint256 outputIndex, uint256[10] memory coords,');
lines.push('        uint256[5] memory scalars, uint256[] memory ls, uint256[] memory rs');
lines.push('    ) {');
rangeCases.forEach((entry, caseIndex) => {
  const input = entry.input;
  lines.push(`        if (index == ${caseIndex}) { // ${entry.id}`);
  lines.push(`            operationId = ${input.operationId};`);
  lines.push(`            outputIndex = ${word(input.outputIndex)};`);
  for (const name of ['coords', 'scalars']) {
    input[name].forEach((value, i) => lines.push(`            ${name}[${i}] = ${word(value)};`));
  }
  for (const name of ['ls', 'rs']) {
    lines.push(`            ${name} = new uint256[](${input[name].length});`);
    input[name].forEach((value, i) => lines.push(`            ${name}[${i}] = ${word(value)};`));
  }
  lines.push('            return (operationId, outputIndex, coords, scalars, ls, rs);');
  lines.push('        }');
});
lines.push('        revert("unknown range case");', '    }', '');
lines.push('    function rangeTraceStep(uint256 index) internal pure returns (');
lines.push('        bytes32 tag, bytes memory payload, bytes32 nextHash,');
lines.push('        uint256 challenge, uint256 counter, bool inner');
lines.push('    ) {');
trace.stages.forEach((stage, index) => {
  lines.push(`        if (index == ${index}) { // ${stage.stage}${stage.roundIndex ?? ''}`);
  if (stage.stage !== 'inner') lines.push(`            tag = keccak256("${stage.stage === 'round' ? 'ecu/bp/round/v3' : `ecu/bp/${stage.stage}/v3`}");`);
  lines.push(`            payload = hex"${stage.payloadHex.slice(2)}";`);
  lines.push(`            nextHash = ${stage.nextState};`);
  if (stage.stage === 'inner') lines.push('            inner = true;');
  else {
    lines.push(`            challenge = ${word(stage.challenge)};`);
    lines.push(`            counter = ${stage.counter};`);
  }
  lines.push('            return (tag, payload, nextHash, challenge, counter, inner);');
  lines.push('        }');
});
lines.push('        revert("unknown trace step");', '    }', '');
lines.push('    function balanceProof(uint256 index) internal pure returns (');
lines.push('        address pool, uint256 chainId, bytes32 operationId,');
lines.push('        uint256 Xx, uint256 Xy, uint256 Rx, uint256 Ry, uint256 s');
lines.push('    ) {');
balanceCases.slice(0, 8).forEach((entry, index) => {
  const base = entry.baseCase ? balanceCases.find(item => item.id === entry.baseCase) : entry;
  const X = entry.expected.X ?? base.expected.X;
  lines.push(`        if (index == ${index}) { // ${entry.id}`);
  lines.push(`            return (${entry.input.pool}, ${word(entry.input.chainId)}, ${entry.input.operationId},`);
  lines.push(`                ${word(X[0])}, ${word(X[1])}, ${word(entry.input.proof.R[0])},`);
  lines.push(`                ${word(entry.input.proof.R[1])}, ${word(entry.input.proof.s)});`);
  lines.push('        }');
});
lines.push('        revert("unknown balance case");', '    }', '');
lines.push(`    bytes4 internal constant RANGE_SELECTOR = ${abiCases[0].expected.selector};`);
lines.push(`    bytes4 internal constant BALANCE_SELECTOR = ${abiCases[1].expected.selector};`);
lines.push('}', '');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, lines.join('\n'));
execFileSync('forge', ['fmt', '--root', 'contracts', target]);
console.log(`Wrote ${target} from ${source}`);
