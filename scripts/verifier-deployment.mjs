import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createPublicClient, http } from 'viem';
import { constructorArgs, hexBytes, parameters, sha256 } from './verifier-artifact.mjs';

const host = '127.0.0.1';
const port = 18546;
const url = `http://${host}:${port}`;

async function occupied() {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

export async function withAnvil(callback) {
  if (await occupied()) throw new Error(`${url} already in use`);
  const child = spawn('anvil', ['--silent', '--host', host, '--port', String(port), '--chain-id', '31337',
    '--hardfork', 'cancun', '--gas-limit', '30000000'], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100; ++i) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try {
        const response = await rpc('eth_chainId', []);
        if (response === '0x7a69') { ready = true; break; }
        throw new Error(`unexpected chain ID ${response}`);
      } catch (error) {
        if (error.message.startsWith('unexpected chain ID')) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Anvil startup timed out');
    return await callback({ url, rpc, client: createPublicClient({ transport: http(url) }) });
  } finally {
    child.kill('SIGTERM');
  }
}

export async function rpc(method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function deployAndCheck(record, environment) {
  const { client } = environment;
  const creation = hexBytes(record.creationBytecode, 'creation bytecode');
  const runtime = hexBytes(record.runtimeBytecode, 'runtime bytecode');
  const args = constructorArgs();
  const initcode = `0x${creation.toString('hex')}${args.slice(2)}`;
  const initcodeBytes = hexBytes(initcode, 'full initcode');
  if (runtime.length > 24576 || initcodeBytes.length > 49152) throw new Error('EIP-170/3860 code size exceeded');
  const accounts = await environment.rpc('eth_accounts', []);
  const from = accounts[0];
  const hash = await environment.rpc('eth_sendTransaction', [{ from, data: initcode, gas: '0x1c9c380' }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('normal deployment failed');
  const address = receipt.contractAddress;
  const onchain = await client.getCode({ address });
  if (onchain?.toLowerCase() !== record.runtimeBytecode.toLowerCase()) throw new Error('deployed runtime mismatch');
  const [base, gs, hs] = parameters();
  const read = (functionName, args = []) => client.readContract({ address, abi: record.abi, functionName, args });
  const hashOnchain = await read('parametersHash');
  if (hashOnchain.toLowerCase() !== record.parametersHash.toLowerCase()) throw new Error('parameter hash mismatch');
  for (const [name, expected] of [['valueBase', base.slice(0, 2)], ['blindingBase', base.slice(2, 4)]]) {
    const actual = await read(name);
    if (actual[0] !== expected[0] || actual[1] !== expected[1]) throw new Error(`${name} state mismatch`);
  }
  for (let i = 0; i < 64; ++i) {
    for (const [name, expected] of [['gs', gs], ['hs', hs]]) {
      const actual = await read(name, [BigInt(i)]);
      if (actual[0] !== expected[i] || actual[1] !== expected[i + 64]) {
        throw new Error(`${name}[${i}] state mismatch`);
      }
    }
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.gasUsed > block.gasLimit) throw new Error('deployment exceeded block gas limit');
  return {
    chainId: 31337, hardfork: 'cancun', address, from,
    transactionHash: hash, blockGasLimit: block.gasLimit.toString(),
    gasUsed: receipt.gasUsed.toString(), runtimeBytes: runtime.length, fullInitcodeBytes: initcodeBytes.length,
    runtimeSha256: sha256(runtime), initcodeSha256: sha256(initcodeBytes),
    constructorInputSha256: sha256(hexBytes(args, 'constructor arguments')),
    initialStateSha256: sha256(hexBytes(args, 'constructor arguments')),
  };
}
