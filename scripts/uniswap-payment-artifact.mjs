import { readFileSync } from 'node:fs';
import { sha256, hashJson, hexBytes } from './verifier-artifact.mjs';

export const artifactPath = 'contracts/out/UniswapPaymentAdapter.sol/UniswapPaymentAdapter.json';
export const outputPath = 'packages/ethereum/generated/uniswap-payment-v1.json';
export const sourcePaths = [
  'contracts/src/integration/uniswap/UniswapPaymentAdapter.sol',
  'contracts/src/IPool.sol', 'contracts/src/PoolTypes.sol', 'contracts/src/PoolBinding.sol',
  'contracts/foundry.toml',
];

const functionNames = [
  'pay', 'isPaymentExecuted', 'paymentDigest', 'pool', 'router02', 'factory', 'weth', 'dUSD', 'pair',
];
const errorNames = [
  'InvalidConfiguration', 'InvalidPayment', 'InvalidPaymentSignature', 'UnsupportedToken',
  'UnsupportedRecipient', 'PaymentExpired', 'PaymentAlreadyExecuted', 'UnexpectedEthReceipt',
  'ReentrantPayment', 'SwapAccountingMismatch', 'DeliveryMismatch',
];

export function createUniswapPaymentRecord(artifact) {
  if (!Array.isArray(artifact.abi) || !artifact.ast || !artifact.storageLayout || !artifact.metadata) {
    throw new Error('Adapter compiler artifact incomplete');
  }
  const settings = artifact.metadata.settings;
  if (!artifact.metadata.compiler.version.startsWith('0.8.37+') || !settings.optimizer.enabled ||
      settings.optimizer.runs !== 200 || settings.evmVersion !== 'cancun' || settings.viaIR === true ||
      settings.compilationTarget?.['src/integration/uniswap/UniswapPaymentAdapter.sol'] !== 'UniswapPaymentAdapter') {
    throw new Error('Adapter compiler settings mismatch');
  }
  const names = type => artifact.abi.filter(item => item.type === type).map(item => item.name);
  for (const name of functionNames) {
    if (!names('function').includes(name)) throw new Error(`Adapter ABI missing ${name}`);
  }
  for (const name of errorNames) {
    if (!names('error').includes(name)) throw new Error(`Adapter error missing ${name}`);
  }
  if (!names('event').includes('PaymentSucceeded') ||
      artifact.abi.filter(item => item.type === 'constructor').length !== 1 ||
      artifact.abi.find(item => item.type === 'constructor').inputs.map(item => item.type).join(',') !==
        'address,address,address,address,address,address' ||
      artifact.abi.filter(item => item.type === 'receive').length !== 1) {
    throw new Error('Adapter event/constructor/receive ABI mismatch');
  }
  const methodIdentifiers = artifact.methodIdentifiers;
  for (const name of functionNames) {
    if (!Object.keys(methodIdentifiers).some(key => key.startsWith(`${name}(`))) {
      throw new Error(`Adapter selector missing ${name}`);
    }
  }
  const creation = hexBytes(artifact.bytecode.object, 'Adapter creation bytecode');
  const runtime = hexBytes(artifact.deployedBytecode.object, 'Adapter runtime bytecode');
  const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(path))]));
  return {
    schemaVersion: 1, abi: artifact.abi, methodIdentifiers,
    creationBytecode: artifact.bytecode.object, runtimeBytecode: artifact.deployedBytecode.object,
    immutableReferences: artifact.deployedBytecode.immutableReferences,
    metadata: artifact.metadata, ast: artifact.ast, storageLayout: artifact.storageLayout,
    sourceSha256,
    manifest: {
      compiler: artifact.metadata.compiler.version, abiSha256: hashJson(artifact.abi),
      creationSha256: sha256(creation), runtimeSha256: sha256(runtime),
      metadataSha256: hashJson(artifact.metadata), astSha256: hashJson(artifact.ast),
      storageLayoutSha256: hashJson(artifact.storageLayout), sourceMapSha256: hashJson(sourceSha256),
    },
  };
}

export function verifyUniswapPaymentRecord(record, artifact) {
  const expected = createUniswapPaymentRecord(artifact);
  if (JSON.stringify(record) !== JSON.stringify(expected)) {
    throw new Error('Adapter record differs from current compiler artifact or sources');
  }
  return expected;
}
