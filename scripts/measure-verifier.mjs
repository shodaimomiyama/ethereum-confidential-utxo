import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { artifactPath, outputPath, validateMeasurements, verifyVerifierRecord } from './verifier-artifact.mjs';
import { deployAndCheck, withAnvil } from './verifier-deployment.mjs';

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const record = JSON.parse(readFileSync(outputPath, 'utf8'));
verifyVerifierRecord(record, artifact, { requireMeasurements: false });
const rangeCase = JSON.parse(readFileSync('tests/vectors/cases/range-v3.json', 'utf8'))
  .find(item => item.id === 'VEC-04-VALID-MIN');
const balanceCase = JSON.parse(readFileSync('tests/vectors/cases/balance.json', 'utf8'))
  .find(item => item.id === 'VEC-05-DEPOSIT');
if (!rangeCase || !balanceCase) throw new Error('measurement vectors missing');

const number = value => BigInt(value);
const range = rangeCase.input;
const balance = balanceCase.input;
const rangeData = encodeFunctionData({ abi: record.abi, functionName: 'verify', args: [
  range.operationId, number(range.outputIndex), range.coords.map(number), range.scalars.map(number),
  range.ls.map(number), range.rs.map(number),
] });
const balanceData = encodeFunctionData({ abi: record.abi, functionName: 'verifyBalance', args: [
  balance.operationId, ...balanceCase.expected.X.map(number), ...balance.proof.R.map(number), number(balance.proof.s),
] });

const output = await withAnvil(async environment => {
  const deployment = await deployAndCheck(record, environment);
  const rows = [{ type: 'deployment', inputId: 'EXP-08-PARAMETERS', chainId: 31337, hardfork: 'cancun',
    runtimeSha256: record.manifest.runtimeSha256, compiler: record.manifest.compiler,
    caller: deployment.from, gasUsed: Number(deployment.gasUsed), transactionHash: deployment.transactionHash,
    condition: 'normal creation transaction; code-size limits enabled; 30,000,000 block gas limit' }];

  async function measure(type, inputId, from, data) {
    const callResult = await environment.rpc('eth_call', [{ from, to: deployment.address, data }, 'latest']);
    if (BigInt(callResult) !== 1n) throw new Error(`${type} vector did not verify`);
    const estimateHex = await environment.rpc('eth_estimateGas', [{ from, to: deployment.address, data }]);
    const hash = await environment.rpc('eth_sendTransaction', [{ from, to: deployment.address, data,
      gas: '0x1c9c380' }]);
    const receipt = await environment.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${type} transaction reverted`);
    rows.push({ type, inputId, chainId: 31337, hardfork: 'cancun',
      runtimeSha256: record.manifest.runtimeSha256, compiler: record.manifest.compiler,
      caller: from, gasUsed: Number(receipt.gasUsed), estimateGas: Number(BigInt(estimateHex)),
      transactionHash: hash, condition: 'one fresh transaction; no access list; cold state access' });
  }

  await measure('range', rangeCase.id, deployment.from, rangeData);
  await environment.rpc('anvil_setBalance', [balance.pool, '0x56bc75e2d63100000']);
  await environment.rpc('anvil_impersonateAccount', [balance.pool]);
  try {
    await measure('balance', balanceCase.id, balance.pool, balanceData);
  } finally {
    await environment.rpc('anvil_stopImpersonatingAccount', [balance.pool]);
  }
  validateMeasurements(rows, record.manifest.runtimeSha256);
  return { deployment, rows };
});

if (output.deployment.initialStateSha256 !== record.deployment.initialStateSha256 ||
    output.deployment.runtimeSha256 !== record.deployment.runtimeSha256) {
  throw new Error('measurement deployment differs from published artifact');
}
const measurementEnvironment = {
  node: process.version,
  forge: execFileSync('forge', ['--version'], { encoding: 'utf8' }).trim(),
  anvil: execFileSync('anvil', ['--version'], { encoding: 'utf8' }).trim(),
  chainId: 31337, hardfork: 'cancun', blockGasLimit: output.deployment.blockGasLimit,
  commands: ['pnpm build', 'pnpm artifact:verifier', 'pnpm measure:verifier', 'pnpm check:verifier'],
  interpretation: 'Individual verifier transactions only; no Pool operation or end-to-end gas claim.',
};
if (process.argv.includes('--check')) {
  if (JSON.stringify(record.measurements) !== JSON.stringify(output.rows) ||
      JSON.stringify(record.measurementEnvironment) !== JSON.stringify(measurementEnvironment)) {
    throw new Error('recorded gas measurement mismatch');
  }
} else {
  record.measurements = output.rows;
  record.measurementEnvironment = measurementEnvironment;
  writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
}
console.log(`Deployment ${output.rows[0].gasUsed}; range ${output.rows[1].gasUsed}; balance ${output.rows[2].gasUsed} gas`);
