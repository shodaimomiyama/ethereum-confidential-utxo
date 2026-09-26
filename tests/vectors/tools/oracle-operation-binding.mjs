import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOperation } from './oracle-abi.mjs';

const casesPath = fileURLToPath(new URL('../cases', import.meta.url));
const operationCases = JSON.parse(readFileSync(new URL('../cases/operation.json', import.meta.url)));
const base = operationCases.find(item => item.id === 'VEC-01-TRANSFER-CHANGE');

export function applyMutation(input, field, replacement) {
  const changed = structuredClone(input);
  const parts = field.replaceAll('[', '.').replaceAll(']', '').split('.');
  let target = changed;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = replacement;
  return changed;
}

const mutations = [
  ['CHAIN-ID', 'chainId', '31338', 'different'],
  ['POOL', 'pool', '0x' + '22'.repeat(20), 'different'],
  ['OWNER', 'owner', '0x' + '22'.repeat(20), 'different'],
  ['SALT', 'salt', '0x' + 'aa'.repeat(32), 'different'],
  ['KIND', 'kind', 2, 'different'],
  ['DEPOSIT-AMOUNT', 'd', '1', 'different'],
  ['WITHDRAW-AMOUNT', 'w', '1', 'different'],
  ['DESTINATION', 'destination', '0x' + '22'.repeat(20), 'different'],
  ['INPUT-IDS-0', 'inputIds[0]', '0x' + '30'.repeat(32), 'different'],
  ['OUTPUTS-0-OWNER', 'outputs[0].owner', '0x' + '22'.repeat(20), 'different'],
  ['OUTPUTS-0-CX', 'outputs[0].Cx', '2', 'different'],
  ['OUTPUTS-0-CY', 'outputs[0].Cy', '3', 'different'],
  ['OUTPUTS-0-FORMAT', 'outputs[0].receiptFormat', 2, 'different'],
  ['OUTPUTS-0-PACKET', 'outputs[0].packet', '0x' + '45'.repeat(112), 'different'],
  ['PROOF', 'proof', '0xdeadbeef', 'same'],
  ['SIGNATURE', 'signature', '0x' + 'ab'.repeat(65), 'same'],
  ['SENDER', 'sender', '0x' + '55'.repeat(20), 'same'],
  ['TX-NONCE', 'txNonce', '9', 'same'],
];

export function buildBindingCases() {
  const baseline = base.expected.operationId;
  return mutations.map(([label, field, replacement, relation]) => {
    const result = buildOperation(applyMutation(base.input, field, replacement));
    if ((result.operationId === baseline) !== (relation === 'same')) {
      throw new Error(`unexpected operationId relation for ${field}`);
    }
    return {
      id: `VEC-01-BIND-${label}`,
      profile: 'operation-v1',
      source: 'docs/design.md#d-04-操作idによる順不同の実行と再使用防止',
      stage: 'operation-id-binding',
      input: { operationCase: base.id, replacement,
        scope: 'encoding only; referenced VEC-01 commitments and packets are opaque test values' },
      expected: { baselineOperationId: baseline, relation,
        operationId: result.operationId, operationPreimage: result.operationPreimage },
      oracle: 'tools/oracle-operation-binding.mjs#buildBindingCases; ethers 6.13.4 independent spot-check',
      consumers: ['#27', '#29', '#30'],
      baseCase: base.id,
      mutatedField: field,
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('usage: --out <directory>');
  const output = resolve(process.argv[flag + 1]);
  if (output === resolve(casesPath)) throw new Error('refusing to overwrite checked-in fixtures');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'operation-binding.json'),
    JSON.stringify(buildBindingCases(), null, 2) + '\n');
}
