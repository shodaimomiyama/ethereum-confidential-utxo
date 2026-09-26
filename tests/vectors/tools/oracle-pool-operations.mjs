import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Wallet, recoverAddress } from 'ethers';
import { authorizationDigest, buildOperation } from './oracle-abi.mjs';

const ownerWallet = new Wallet(`0x${'01'.repeat(32)}`);
const recipientWallet = new Wallet(`0x${'02'.repeat(32)}`);
const pool = '0x1111111111111111111111111111111111111111';
const callback = '0x3333333333333333333333333333333333333333';
const zero = '0x0000000000000000000000000000000000000000';
const authorizations = { OperationAuthorization: [
  { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
  { name: 'authScheme', type: 'uint8' }, { name: 'authVersion', type: 'uint8' },
] };

export async function makeCases(base, parameters) {
  const byName = new Map();
  const recipient = recipientWallet.address.toLowerCase();
  const cases = [];
  for (const [number, item] of base.entries()) {
    const signer = item.ownerSymbol === 'B' ? recipientWallet : ownerWallet;
    const owner = signer.address.toLowerCase();
    const inputRefs = item.inputs.map(ref => {
      const [name, position] = ref.split(':');
      const previous = byName.get(name);
      if (!previous) throw new Error(`unknown input fixture: ${ref}`);
      return { id: previous.expected.outputIds[Number(position)], value: BigInt(previous.input.outputs[Number(position)].value) };
    });
    inputRefs.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    const outputs = item.outputs.map(output => ({ ...output,
      owner: output.ownerSymbol === 'A' ? ownerWallet.address.toLowerCase() : recipient }));
    const destination = item.destinationSymbol === 'ZERO' ? zero
      : item.destinationSymbol === 'POOL' ? pool
      : item.destinationSymbol === 'CALLBACK' ? callback : recipient;
    const actualDestination = item.destinationSymbol === 'OWNER' ? owner : destination;
    const salt = `0x${number.toString(16).padStart(2, '0').repeat(32)}`;
    const input = { chainId: '31337', pool, kind: item.kind, owner, salt,
      inputIds: inputRefs.map(ref => ref.id), outputs,
      d: item.d, w: item.w, destination: actualDestination };
    const inputValue = inputRefs.reduce((sum, ref) => sum + ref.value, 0n);
    const outputValue = outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
    if (inputValue + BigInt(item.d) !== outputValue + BigInt(item.w)) {
      throw new Error(`unbalanced public fixture: ${item.name}`);
    }
    const binding = buildOperation(input);
    const domain = { name: 'Ethereum Confidential UTXO', version: '1',
      chainId: 31337, verifyingContract: pool };
    const signature = await signer.signTypedData(domain, authorizations,
      { operationId: binding.operationId, owner, authScheme: 1, authVersion: 1 });
    const digest = authorizationDigest({ chainId: '31337', pool },
      { operationId: binding.operationId, owner });
    if (recoverAddress(digest, signature).toLowerCase() !== owner) throw new Error('signature mismatch');
    const entry = {
      id: `VEC-07-POOL-${item.name}`, profile: 'pool-operation-v1',
      source: 'docs/design.md#操作の結合とabi', stage: 'application-operation',
      input, expected: { operationId: binding.operationId,
        outputIds: binding.outputIds.map(value => value.hash), signature,
        balanceProof: { Rx: parameters.base[2], Ry: parameters.base[3], s: '1' },
        rangeProofs: [], outputValues: outputs.map(output => output.value) },
      oracle: 'test-only public openings, viem operation hash, ethers EIP-712 signature, Python v3 proof',
      consumers: ['#27', '#36'],
    };
    byName.set(item.name, entry);
    cases.push(entry);
  }
  return cases;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('usage: oracle-pool-operations.mjs <base.json> <out.json>');
  const base = JSON.parse(readFileSync(inputPath, 'utf8'));
  const parameters = JSON.parse(readFileSync('experiments/design/crypto-profile-v3/exp08/parameters.json', 'utf8'));
  const cases = await makeCases(base, parameters);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(cases, null, 2)}\n`);
}
