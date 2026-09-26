import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const outputFile = fileURLToPath(new URL('../cases/uniswap-payment.json', import.meta.url));
const ownerKey = `0x${'01'.repeat(32)}`;
const account = privateKeyToAccount(ownerKey);
const pool = '0x1111111111111111111111111111111111111111';
const adapter = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const recipient = '0x4444444444444444444444444444444444444444';
const typeString = 'PaymentAuthorization(bytes32 operationId,address owner,uint256 ethAmount,address token,uint256 minAmountOut,address recipient,uint64 deadline)';
const types = { PaymentAuthorization: [
  { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
  { name: 'ethAmount', type: 'uint256' }, { name: 'token', type: 'address' },
  { name: 'minAmountOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
  { name: 'deadline', type: 'uint64' },
] };

const tag = value => keccak256(stringToHex(value));
const encodeHash = (types, values) => keccak256(encodeAbiParameters(parseAbiParameters(types), values));

function operationIdFor(request) {
  const inputsHash = encodeHash('bytes32,bytes32[]', [tag('ecu/inputs/v1'), request.inputIds]);
  const outputs = request.outputs.map((output, index) => encodeHash(
    'bytes32,uint256,address,uint256,uint256,uint8,bytes32',
    [tag('ecu/output/v1'), BigInt(index), output.owner, BigInt(output.Cx), BigInt(output.Cy),
      output.receiptFormat, keccak256(output.packet)]));
  const outputsHash = encodeHash('bytes32,bytes32[]', [tag('ecu/outputs/v1'), outputs]);
  return encodeHash('bytes32,uint256,address,uint8,address,bytes32,bytes32,bytes32,uint256,uint256,address',
    [tag('ecu/operation/v1'), BigInt(request.chainId), request.pool, request.kind, request.owner,
      request.salt, inputsHash, outputsHash, BigInt(request.d), BigInt(request.w), request.destination]);
}

const operation = {
  chainId: '31337', pool, kind: 2, owner: account.address, salt: `0x${'21'.repeat(32)}`,
  inputIds: [`0x${'2c'.repeat(32)}`], outputs: [{
    owner: account.address, Cx: '0', Cy: '0', receiptFormat: 1, packet: '0x',
  }], d: '0', w: '3', destination: adapter,
};

async function generate() {
  const operationId = operationIdFor(operation);
  const terms = { operationId, owner: account.address, ethAmount: 3n,
    token, minAmountOut: 2n, recipient, deadline: 1000n };
  const domain = { name: 'Ethereum Confidential UTXO Uniswap Payment', version: '1',
    chainId: 31337, verifyingContract: adapter };
  const domainType = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const typeHash = keccak256(stringToHex(typeString));
  const domainSeparator = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32,bytes32,bytes32,uint256,address'),
    [domainType, keccak256(stringToHex(domain.name)), keccak256(stringToHex(domain.version)), 31337n, adapter]));
  const structHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32,bytes32,address,uint256,address,uint256,address,uint64'),
    [typeHash, operationId, terms.owner, terms.ethAmount, token, terms.minAmountOut, recipient, terms.deadline]));
  const paymentId = hashTypedData({ domain, types, primaryType: 'PaymentAuthorization', message: terms });
  const signature = await account.signTypedData({ domain, types, primaryType: 'PaymentAuthorization', message: terms });
  return { schemaVersion: 1, oracle: 'viem 2.56.9 independent ABI operation ID and hashTypedData/signTypedData',
    input: { operation, adapter, token, recipient, minAmountOut: '2', deadline: '1000' },
    expected: { operationId, domainSeparator, typeHash, structHash, paymentId, signature } };
}

const result = `${JSON.stringify(await generate(), null, 2)}\n`;
if (process.argv.includes('--refresh')) writeFileSync(outputFile, result);
if (readFileSync(outputFile, 'utf8') !== result) throw new Error('Uniswap payment vector differs from independent oracle');
console.log('Uniswap payment vector matches independent oracle');
