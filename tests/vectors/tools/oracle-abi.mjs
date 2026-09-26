import {
  encodeAbiParameters, parseAbiParameters, keccak256, stringToHex,
  concatHex,
} from 'viem';
import { Wallet, recoverAddress } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = label => keccak256(stringToHex(label));
const TAG = Object.freeze({
  info: tag('ecu/hpke-info/v1'),
  input: tag('ecu/inputs/v1'),
  output: tag('ecu/output/v1'),
  outputs: tag('ecu/outputs/v1'),
  operation: tag('ecu/operation/v1'),
  outputId: tag('ecu/output-id/v1'),
});

function digest(signature, values) {
  const preimage = encodeAbiParameters(parseAbiParameters(signature), values);
  return { preimage, hash: keccak256(preimage) };
}

export function inputIdsHash(ids) {
  return digest('bytes32, bytes32[]', [TAG.input, ids]);
}

export function buildOperation(input) {
  const chainId = BigInt(input.chainId);
  const outputData = input.outputs.map((output, index) => {
    const info = digest('bytes32, uint256, address, uint8, bytes32, uint256, address, uint256, uint256, uint8',
      [TAG.info, chainId, input.pool, input.kind, input.salt, BigInt(index), output.owner,
        BigInt(output.Cx), BigInt(output.Cy), output.receiptFormat]);
    const packetHash = keccak256(output.packet);
    const hash = digest('bytes32, uint256, address, uint256, uint256, uint8, bytes32',
      [TAG.output, BigInt(index), output.owner, BigInt(output.Cx), BigInt(output.Cy),
        output.receiptFormat, packetHash]);
    return { info, packetHash, hash };
  });
  const inputs = inputIdsHash(input.inputIds);
  const outputs = digest('bytes32, bytes32[]', [TAG.outputs, outputData.map(item => item.hash.hash)]);
  const operation = digest('bytes32, uint256, address, uint8, address, bytes32, bytes32, bytes32, uint256, uint256, address',
    [TAG.operation, chainId, input.pool, input.kind, input.owner, input.salt, inputs.hash,
      outputs.hash, BigInt(input.d), BigInt(input.w), input.destination]);
  const outputIds = outputData.map((_, index) =>
    digest('bytes32, bytes32, uint256', [TAG.outputId, operation.hash, BigInt(index)]));
  return {
    info: outputData.map(item => item.info),
    packetHashes: outputData.map(item => item.packetHash),
    outputHashes: outputData.map(item => item.hash),
    inputIdsHash: inputs,
    outputsHash: outputs,
    operationId: operation.hash,
    operationPreimage: operation.preimage,
    outputIds,
  };
}

export function authorizationParts(domain, authorization) {
  const domainType = tag('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  const domainSeparator = digest('bytes32, bytes32, bytes32, uint256, address',
    [domainType, tag('Ethereum Confidential UTXO'), tag('1'), BigInt(domain.chainId), domain.pool]);
  const typeHash = tag('OperationAuthorization(bytes32 operationId,address owner,uint8 authScheme,uint8 authVersion)');
  const structHash = digest('bytes32, bytes32, address, uint8, uint8',
    [typeHash, authorization.operationId, authorization.owner, 1, 1]);
  const digestHex = keccak256(concatHex(['0x1901', domainSeparator.hash, structHash.hash]));
  return { domainSeparator, typeHash, structHash, digest: digestHex };
}

export function authorizationDigest(domain, authorization) {
  return authorizationParts(domain, authorization).digest;
}

export function recipientInfoParts(domain, info) {
  const domainType = tag('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
  const domainSeparator = digest('bytes32, bytes32, bytes32, uint256, address',
    [domainType, tag('Ethereum Confidential UTXO'), tag('1'), BigInt(domain.chainId), domain.pool]);
  const typeHash = tag('RecipientInfo(address owner,bytes32 receivePublicKey,uint8 receiptFormat,uint8 recipientInfoVersion)');
  const structHash = digest('bytes32, address, bytes32, uint8, uint8',
    [typeHash, info.owner, info.receivePublicKey, info.receiptFormat, info.recipientInfoVersion]);
  return { domainSeparator, typeHash, structHash,
    digest: keccak256(concatHex(['0x1901', domainSeparator.hash, structHash.hash])) };
}

const TEST_OWNER_KEY = '0x' + '01'.repeat(32);
const POOL = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const INPUT_A = '0x' + '10'.repeat(32);
const INPUT_B = '0x' + '20'.repeat(32);

const eventSignatures = Object.freeze({
  InputConsumed: 'InputConsumed(bytes32,bytes32)',
  OutputCreated: 'OutputCreated(address,bytes32,bytes32,uint256,uint256,uint256,uint8,bytes)',
  OperationSucceeded: 'OperationSucceeded(bytes32,uint8,address,bytes32[],bytes32[],uint256,uint256,address,bytes32)',
});
const selector = signature => keccak256(stringToHex(signature)).slice(0, 10);
const indexedAddress = address => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
const observation = (id, stage, input, expected) => ({
  id: `VEC-06-${id}`, profile: 'pool-observation-v1',
  source: stage === 'error' ? 'docs/design.md#拒否理由のabi' :
    'docs/design.md#イベントと照会のabi', stage, input, expected,
  oracle: 'viem 2.56.9 ABI encoding; ethers 6.13.4 independent decoding',
  consumers: ['#27', '#29', '#30'],
});

export function buildOperationLogs(operation) {
  const { input, expected } = operation;
  const opId = expected.operationId;
  const logs = input.inputIds.map(inputId => ({
    name: 'InputConsumed',
    topics: [keccak256(stringToHex(eventSignatures.InputConsumed)), inputId, opId],
    data: '0x', args: [inputId, opId],
  }));
  input.outputs.forEach((output, index) => {
    const outputId = expected.outputIds[index].hash;
    logs.push({
      name: 'OutputCreated',
      topics: [keccak256(stringToHex(eventSignatures.OutputCreated)),
        indexedAddress(output.owner), outputId, opId],
      data: encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint8, bytes'),
        [BigInt(index), BigInt(output.Cx), BigInt(output.Cy), output.receiptFormat, output.packet]),
      args: [output.owner, outputId, opId, String(index), output.Cx, output.Cy,
        String(output.receiptFormat), output.packet],
    });
  });
  logs.push({
    name: 'OperationSucceeded',
    topics: [keccak256(stringToHex(eventSignatures.OperationSucceeded)),
      opId, indexedAddress(input.owner)],
    data: encodeAbiParameters(parseAbiParameters(
      'uint8, bytes32[], bytes32[], uint256, uint256, address, bytes32'),
    [input.kind, input.inputIds, expected.outputIds.map(item => item.hash),
      BigInt(input.d), BigInt(input.w), input.destination, input.salt]),
    args: [opId, String(input.kind), input.owner, input.inputIds,
      expected.outputIds.map(item => item.hash), input.d, input.w,
      input.destination, input.salt],
  });
  return logs;
}

export function validateSyncLogs(operation, logs) {
  if (!Array.isArray(logs)) return false;
  const expected = buildOperationLogs(operation);
  if (logs.length !== expected.length) return false;
  return logs.every((log, index) => log.name === expected[index].name &&
    log.data.toLowerCase() === expected[index].data.toLowerCase() &&
    Array.isArray(log.topics) && log.topics.length === expected[index].topics.length &&
    log.topics.every((topic, topicIndex) =>
      topic.toLowerCase() === expected[index].topics[topicIndex].toLowerCase()));
}

const queryDefinitions = [
  ['getUtxo', 'getUtxo(bytes32)', 'bytes32', 'uint8, address, uint256, uint256'],
  ['isOperationExecuted', 'isOperationExecuted(bytes32)', 'bytes32', 'bool'],
  ['getAccounting', 'getAccounting()', '', 'uint256, uint256, uint256'],
];

function queryCase(id, name, args, values) {
  const [, signature, inputTypes, outputTypes] = queryDefinitions.find(item => item[0] === name);
  const calldata = concatHex([selector(signature),
    inputTypes ? encodeAbiParameters(parseAbiParameters(inputTypes), args) : '0x']);
  const returndata = encodeAbiParameters(parseAbiParameters(outputTypes), values);
  return observation(id, 'query', { name, args }, { decision: 'accept',
    selector: selector(signature), calldata, returndata, values: values.map(value =>
      typeof value === 'bigint' ? value.toString() : value) });
}

const errorDefinitions = [
  ['InvalidRequest', ''], ['PublicAmountOutOfRange', ''],
  ['MsgValueMismatch', 'uint256,uint256', ['1', '2']], ['ReentrantOperation', ''],
  ['InputNotFound', 'bytes32', [INPUT_A]], ['InputAlreadySpent', 'bytes32', [INPUT_A]],
  ['DuplicateInput', 'bytes32', [INPUT_A]], ['InputOwnerMismatch', 'bytes32', [INPUT_A]],
  ['OperationAlreadyExecuted', 'bytes32', []], ['OutputIdCollision', 'bytes32', []],
  ['InvalidAuthorization', ''], ['InvalidBalanceProof', ''],
  ['InvalidRangeProof', 'uint256', ['1']],
  ['WithdrawalFailed', 'address,uint256', [RECIPIENT, '1']],
  ['AccountingInvariantViolation', ''],
];

export function buildObservationCases(operations) {
  const selected = [operations[0], operations[2], operations[5]];
  const accepted = selected.map(operation => observation(
    `LOG-${operation.id.slice('VEC-01-'.length)}`, 'sync-log',
    { operationCase: operation.id },
    { decision: 'accept', logs: buildOperationLogs(operation) }));
  const transfer = operations[2];
  const full = buildOperationLogs(transfer);
  const mutations = [
    ['MISSING', full.slice(0, -1), 'logs.length'],
    ['ORDER', [full[1], full[0], ...full.slice(2)], 'logs.order'],
    ['OUTPUT-ID', full.map((log, index) => index === 1 ?
      { ...log, topics: [log.topics[0], log.topics[1], INPUT_B, log.topics[3]] } : log),
    'logs[1].topics[2]'],
    ['PACKET', full.map((log, index) => index === 1 ?
      { ...log, data: log.data.slice(0, -34) + '45' + log.data.slice(-32) } : log),
    'logs[1].data'],
  ].map(([label, logs, mutatedField]) => ({
    ...observation(`LOG-${label}`, 'sync-log',
      { operationCase: transfer.id, logs }, { decision: 'reject', reason: 'incomplete or inconsistent logs' }),
    baseCase: 'VEC-06-LOG-TRANSFER-CHANGE', mutatedField,
  }));
  const outputId = operations[0].expected.outputIds[0].hash;
  const opId = operations[0].expected.operationId;
  const queries = [
    queryCase('GET-UTXO-ABSENT', 'getUtxo', [INPUT_B], [0, ZERO_ADDRESS, 0n, 0n]),
    queryCase('GET-UTXO-LIVE', 'getUtxo', [outputId],
      [1, operations[0].input.owner, 1n, 2n]),
    queryCase('GET-UTXO-SPENT', 'getUtxo', [INPUT_A],
      [2, operations[0].input.owner, 1n, 2n]),
    queryCase('IS-EXECUTED', 'isOperationExecuted', [opId], [true]),
    queryCase('IS-NOT-EXECUTED', 'isOperationExecuted', [INPUT_B], [false]),
    queryCase('ACCOUNTING', 'getAccounting', [], [3n, 2n, 1n]),
    observation('ACCOUNTING-DEFICIT', 'query', { name: 'getAccounting',
      actualBalance: '1', accountedLiability: '2' },
    { decision: 'reject', error: 'AccountingInvariantViolation',
      data: selector('AccountingInvariantViolation()') }),
  ];
  const errors = errorDefinitions.map(([name, types, sampleArgs]) => {
    const args = sampleArgs?.length ? sampleArgs :
      name === 'OperationAlreadyExecuted' ? [opId] :
        name === 'OutputIdCollision' ? [outputId] : [];
    const signature = `${name}(${types})`;
    const errorSelector = selector(signature);
    return observation(`ERROR-${name.replace(/([a-z])([A-Z])/g, '$1-$2').toUpperCase()}`,
      'error', { name, args }, { selector: errorSelector,
        data: concatHex([errorSelector, types ?
          encodeAbiParameters(parseAbiParameters(types), args) : '0x']) });
  });
  return [...accepted, ...mutations, ...queries, ...errors];
}

function operationSeeds(owner) {
  const packet = '0x' + '44'.repeat(112);
  const recipientOutput = { owner: RECIPIENT, Cx: '1', Cy: '2', receiptFormat: 1, packet };
  const changeOutput = { owner, Cx: '1', Cy: '2', receiptFormat: 1, packet };
  const common = { chainId: '31337', pool: POOL, owner, d: '0', w: '0',
    destination: ZERO_ADDRESS };
  return [
    ['DEPOSIT', { ...common, kind: 0, salt: '0x' + '01'.repeat(32), inputIds: [],
      outputs: [changeOutput], d: '1' }],
    ['TRANSFER-ONE', { ...common, kind: 1, salt: '0x' + '02'.repeat(32),
      inputIds: [INPUT_A], outputs: [recipientOutput] }],
    ['TRANSFER-CHANGE', { ...common, kind: 1, salt: '0x' + '03'.repeat(32),
      inputIds: [INPUT_A], outputs: [recipientOutput, changeOutput] }],
    ['TRANSFER-MERGE', { ...common, kind: 1, salt: '0x' + '04'.repeat(32),
      inputIds: [INPUT_A, INPUT_B], outputs: [recipientOutput, changeOutput] }],
    ['TRANSFER-SELF', { ...common, kind: 1, salt: '0x' + '05'.repeat(32),
      inputIds: [INPUT_A], outputs: [{ ...recipientOutput, owner }, changeOutput] }],
    ['WITHDRAW-FULL', { ...common, kind: 2, salt: '0x' + '06'.repeat(32),
      inputIds: [INPUT_A], outputs: [], w: '1', destination: RECIPIENT }],
    ['WITHDRAW-PARTIAL', { ...common, kind: 2, salt: '0x' + '07'.repeat(32),
      inputIds: [INPUT_A, INPUT_B], outputs: [changeOutput], w: '1', destination: RECIPIENT }],
  ];
}

function caseEntry(id, stage, input, expected, consumers, oracle) {
  return { id, profile: 'operation-v1', source: 'docs/design.md#操作の結合とabi',
    stage, input, expected, oracle, consumers };
}

export async function generateAbiCases() {
  const wallet = new Wallet(TEST_OWNER_KEY);
  const owner = wallet.address.toLowerCase();
  const operations = operationSeeds(owner).map(([name, input]) =>
    caseEntry(`VEC-01-${name}`, 'encoding', input, buildOperation(input),
      ['#27', '#29', '#30'], 'viem 2.56.9; ethers 6.13.4 cross-check'));
  const depositInput = operations[0].input;
  const mergeInput = operations[3].input;
  const invalidOperations = [
    ['INPUT-ORDER', mergeInput, 'VEC-01-TRANSFER-MERGE', 'inputIds.order',
      value => { value.inputIds.reverse(); }],
    ['INPUT-DUPLICATE', mergeInput, 'VEC-01-TRANSFER-MERGE', 'inputIds.duplicate',
      value => { value.inputIds[1] = value.inputIds[0]; }],
    ['UNKNOWN-KIND', depositInput, 'VEC-01-DEPOSIT', 'kind',
      value => { value.kind = 3; }],
    ['UNKNOWN-RECEIPT', depositInput, 'VEC-01-DEPOSIT', 'outputs[0].receiptFormat',
      value => { value.outputs[0].receiptFormat = 2; }],
    ['SHORT-PACKET', depositInput, 'VEC-01-DEPOSIT', 'outputs[0].packet.length',
      value => { value.outputs[0].packet = '0x' + '44'.repeat(111); }],
    ['UNUSED-W', depositInput, 'VEC-01-DEPOSIT', 'w',
      value => { value.w = '1'; }],
    ['ZERO-DEPOSIT', depositInput, 'VEC-01-DEPOSIT', 'd',
      value => { value.d = '0'; }],
    ['UNUSED-DESTINATION', depositInput, 'VEC-01-DEPOSIT', 'destination',
      value => { value.destination = RECIPIENT; }],
  ].map(([name, baseInput, baseCase, mutatedField, mutate]) => {
    const input = structuredClone(baseInput);
    mutate(input);
    return { ...caseEntry(`VEC-01-${name}`, 'pool-request', input,
      { decision: 'reject', reason: name === 'ZERO-DEPOSIT' ? 'PublicAmountOutOfRange' : 'InvalidRequest' }, ['#27', '#29'],
      'design request-shape rule'), baseCase, mutatedField };
  });
  const operation = operations[0];
  const domain = { chainId: operation.input.chainId, pool: POOL };
  const authData = { operationId: operation.expected.operationId, owner };
  const authParts = authorizationParts(domain, authData);
  const authTypes = { OperationAuthorization: [
    { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
    { name: 'authScheme', type: 'uint8' }, { name: 'authVersion', type: 'uint8' },
  ] };
  const typedDomain = { name: 'Ethereum Confidential UTXO', version: '1',
    chainId: Number(domain.chainId), verifyingContract: POOL };
  const authSignature = await wallet.signTypedData(typedDomain, authTypes,
    { ...authData, authScheme: 1, authVersion: 1 });
  if (recoverAddress(authParts.digest, authSignature).toLowerCase() !== owner) {
    throw new Error('test-only operation signature failed recovery');
  }
  const recipientData = { owner, receivePublicKey: '0x' + '66'.repeat(32),
    receiptFormat: 1, recipientInfoVersion: 1 };
  const recipientParts = recipientInfoParts(domain, recipientData);
  const recipientTypes = { RecipientInfo: [
    { name: 'owner', type: 'address' }, { name: 'receivePublicKey', type: 'bytes32' },
    { name: 'receiptFormat', type: 'uint8' },
    { name: 'recipientInfoVersion', type: 'uint8' },
  ] };
  const recipientSignature = await wallet.signTypedData(typedDomain, recipientTypes,
    recipientData);
  if (recoverAddress(recipientParts.digest, recipientSignature).toLowerCase() !== owner) {
    throw new Error('test-only recipient signature failed recovery');
  }
  const authorization = [
    caseEntry('VEC-02-OPERATION-SIGNATURE', 'signature',
      { ...domain, ...authData, authScheme: 1, authVersion: 1, signature: authSignature,
        testOnlyPrivateKey: TEST_OWNER_KEY },
      { ...authParts, recoveredOwner: owner, decision: 'accept' },
      ['#27', '#29', '#30'], 'ethers 6.13.4 signing; viem 2.56.9 digest'),
    caseEntry('VEC-02-RECIPIENT-SIGNATURE', 'recipient-info-signature',
      { ...domain, ...recipientData, signature: recipientSignature,
        testOnlyPrivateKey: TEST_OWNER_KEY },
      { ...recipientParts, recoveredOwner: owner, decision: 'accept' },
      ['#28', '#29'], 'ethers 6.13.4 signing; viem 2.56.9 digest'),
  ];
  const secpOrder = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const highS = '0x' + authSignature.slice(2, 66) +
    (secpOrder - BigInt('0x' + authSignature.slice(66, 130))).toString(16).padStart(64, '0') +
    authSignature.slice(130);
  const invalidAuthorizations = [
    ['CHAIN-CHANGED', 'VEC-02-OPERATION-SIGNATURE', 'chainId', { chainId: '31338' }],
    ['POOL-CHANGED', 'VEC-02-OPERATION-SIGNATURE', 'pool', { pool: RECIPIENT }],
    ['OWNER-CHANGED', 'VEC-02-OPERATION-SIGNATURE', 'owner', { owner: RECIPIENT }],
    ['HIGH-S', 'VEC-02-OPERATION-SIGNATURE', 'signature.s', { signature: highS }],
    ['ZERO-R', 'VEC-02-OPERATION-SIGNATURE', 'signature.r',
      { signature: '0x' + '00'.repeat(32) + authSignature.slice(66) }],
    ['ZERO-S', 'VEC-02-OPERATION-SIGNATURE', 'signature.s',
      { signature: authSignature.slice(0, 66) + '00'.repeat(32) + authSignature.slice(130) }],
    ['BAD-V', 'VEC-02-OPERATION-SIGNATURE', 'signature.v',
      { signature: authSignature.slice(0, 130) + '1d' }],
    ['SHORT-SIGNATURE', 'VEC-02-OPERATION-SIGNATURE', 'signature.length',
      { signature: authSignature.slice(0, 130) }],
    ['RECIPIENT-KEY-CHANGED', 'VEC-02-RECIPIENT-SIGNATURE', 'receivePublicKey',
      { receivePublicKey: '0x' + '67'.repeat(32) }],
    ['RECIPIENT-FORMAT-CHANGED', 'VEC-02-RECIPIENT-SIGNATURE', 'receiptFormat',
      { receiptFormat: 2 }],
    ['RECIPIENT-VERSION-CHANGED', 'VEC-02-RECIPIENT-SIGNATURE', 'recipientInfoVersion',
      { recipientInfoVersion: 2 }],
  ].map(([name, baseCase, mutatedField, change]) => {
    const base = authorization.find(item => item.id === baseCase);
    return { ...caseEntry(`VEC-02-${name}`, base.stage, { ...base.input, ...change },
      { decision: 'reject', reason: 'invalid signature or recipient info' },
      base.consumers, 'design signature and version rules'), baseCase, mutatedField };
  });
  return { operations, invalidOperations, authorization: [...authorization, ...invalidAuthorizations] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--out' || !process.argv[3] || process.argv.length !== 4) {
    throw new Error('Usage: node oracle-abi.mjs --out <directory>');
  }
  const output = resolve(process.argv[3]);
  mkdirSync(output, { recursive: true });
  const { operations, invalidOperations, authorization } = await generateAbiCases();
  writeFileSync(join(output, 'operation.json'), JSON.stringify(operations, null, 2) + '\n');
  writeFileSync(join(output, 'operation-rejected.json'), JSON.stringify(invalidOperations, null, 2) + '\n');
  writeFileSync(join(output, 'authorization.json'), JSON.stringify(authorization, null, 2) + '\n');
  writeFileSync(join(output, 'abi-observation.json'),
    JSON.stringify(buildObservationCases(operations), null, 2) + '\n');
}
