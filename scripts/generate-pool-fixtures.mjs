import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const { Interface } = createRequire(join(root, 'tests/vectors/package.json'))('ethers');
const uniswap = process.argv.includes('--uniswap');
const casesFile = join(root, uniswap ? 'tests/vectors/cases/uniswap-payment-operations.json'
  : 'tests/vectors/cases/pool-operations.json');
const fixtureFile = join(root, uniswap ? 'contracts/test/fixtures/uniswap-payment-calldata.json'
  : 'contracts/test/fixtures/pool-calldata.json');
const python = process.env.POOL_VECTOR_PYTHON || 'python3';
const digest = value => createHash('sha256').update(value).digest('hex');
const temp = mkdtempSync(join(tmpdir(), 'ecu-pool-fixtures-'));

function run(program, args) {
  execFileSync(program, args, { cwd: root, stdio: 'inherit' });
}

try {
  const base = join(temp, 'base.json');
  const signed = join(temp, 'signed.json');
  const proved = join(temp, 'proved.json');
  run(python, ['tests/vectors/tools/oracle_pool_base.py', '--out', base,
    ...(uniswap ? ['--uniswap'] : [])]);
  run(process.execPath, ['tests/vectors/tools/oracle-pool-operations.mjs', base, signed]);
  run(python, ['tests/vectors/tools/oracle_pool_proofs.py', '--in-base', signed, '--out', proved]);
  const allCases = JSON.parse(readFileSync(proved));
  const generated = uniswap
    ? Buffer.from(`${JSON.stringify(allCases.filter(item =>
      ['DEPOSIT-PAY', 'WITHDRAW-PAY', 'WITHDRAW-PAY-DUST'].some(name => item.id.endsWith(name))), null, 2)}\n`)
    : readFileSync(proved);
  if (process.argv.includes('--refresh')) writeFileSync(casesFile, generated);
  if (!generated.equals(readFileSync(casesFile))) throw new Error('published Pool cases differ from regenerated oracle output');
  const cases = JSON.parse(generated);
  const artifact = JSON.parse(readFileSync(join(root, 'contracts/out/IPool.sol/IPool.json')));
  const iface = new Interface(artifact.abi);
  const fixture = {};
  for (const item of cases) {
    const name = item.id.replace('VEC-07-POOL-', '').replaceAll('-', '_');
    const input = item.input;
    const request = [input.kind, input.owner, input.salt, input.inputIds,
      input.outputs.map(output => [output.owner, output.Cx, output.Cy, output.receiptFormat, output.packet]),
      input.d, input.w, input.destination];
    const balance = [item.expected.balanceProof.Rx, item.expected.balanceProof.Ry, item.expected.balanceProof.s];
    const range = item.expected.rangeProofs.map(proof => [proof.coords, proof.scalars, proof.ls, proof.rs]);
    const method = ['deposit', 'transfer', 'withdraw'][input.kind];
    const args = input.kind === 0 ? [request, balance, item.expected.signature]
      : [request, balance, range, item.expected.signature];
    fixture[name] = { calldata: iface.encodeFunctionData(method, args), operationId: item.expected.operationId,
      outputIds: item.expected.outputIds, d: input.d, w: input.w, owner: input.owner,
      destination: input.destination, outputValues: item.expected.outputValues,
      sourceCase: item.id };
  }
  const output = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.argv.includes('--refresh')) writeFileSync(fixtureFile, output);
  if (output !== readFileSync(fixtureFile, 'utf8')) throw new Error('Pool calldata fixture differs from regenerated cases');
  console.log(`Verified ${cases.length} Pool scenarios; case sha256 ${digest(generated)}; calldata sha256 ${digest(output)}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
