import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, parseAbi } from 'viem';

const rangeAbi = parseAbi(['function verify(bytes32 operationId,uint256 outputIndex,uint256[10] coords,uint256[5] scalars,uint256[] ls,uint256[] rs) view returns (bool)']);
const balanceAbi = parseAbi(['function verifyBalance(bytes32 operationId,uint256 Xx,uint256 Xy,uint256 Rx,uint256 Ry,uint256 s) view returns (bool)']);
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const source = JSON.parse(readFileSync(join(root, 'experiments/design/crypto-profile-v3/exp08/java-result.json')));
const shape = (id, fn, input, calldata) => ({
  id, profile: 'verifier-abi-v3', source: 'docs/design.md#検証器の固定abi',
  stage: 'verifier-calldata', input: { function: fn, ...input },
  expected: { selector: calldata.slice(0, 10), calldata },
  oracle: 'viem 2.56.9 encodeFunctionData; ethers 6.13.4 independent decode',
  consumers: ['#26', '#27', '#30'],
});

export function buildVerifierAbiCases() {
  const proof = source.proofs[0];
  const opId = proof.operationId;
  const rangeInput = { operationId: opId, outputIndex: proof.outputIndex,
    coords: proof.coords, scalars: proof.scalars, ls: proof.ls, rs: proof.rs };
  const rangeData = encodeFunctionData({ abi: rangeAbi, functionName: 'verify',
    args: [opId, BigInt(proof.outputIndex), ...[proof.coords, proof.scalars, proof.ls, proof.rs].map(a => a.map(BigInt))] });
  const balanceInput = { operationId: opId, Xx: '0', Xy: '0', Rx: '1', Ry: '2', s: '1' };
  const balanceData = encodeFunctionData({ abi: balanceAbi, functionName: 'verifyBalance',
    args: [opId, 0n, 0n, 1n, 2n, 1n] });
  return [shape('VEC-04-VERIFY-CALLDATA', 'verify', rangeInput, rangeData),
    shape('VEC-05-VERIFY-BALANCE-CALLDATA', 'verifyBalance', balanceInput, balanceData)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('usage: node oracle-verifier-abi.mjs --out DIR');
  const out = resolve(process.argv[flag + 1]);
  if (out === join(root, 'tests/vectors/cases')) throw new Error('choose separate output directory');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'verifier-abi.json'), JSON.stringify(buildVerifierAbiCases(), null, 2) + '\n');
}
