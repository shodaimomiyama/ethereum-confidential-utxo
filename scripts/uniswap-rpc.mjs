import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPOLIA_CHAIN_ID = 11155111;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

function assertAddress(value, name) {
  if (!addressPattern.test(value ?? '')) throw new Error(`${name} address invalid`);
  return value.toLowerCase();
}

function decodeAddress(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? '')) throw new Error(`${name} response invalid`);
  if (!/^0{24}$/i.test(value.slice(2, 26))) throw new Error(`${name} response invalid`);
  return `0x${value.slice(26).toLowerCase()}`;
}

function checkCors(response, browserOrigin) {
  const allow = response.headers.get('access-control-allow-origin');
  if (allow !== '*' && allow !== browserOrigin) throw new Error('RPC browser CORS denied');
}

export async function probeSepolia({ rpcUrl, browserOrigin, blockNumber, expectedDeployments }) {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//i.test(rpcUrl)) throw new Error('RPC URL invalid');
  if (!/^https?:\/\//i.test(browserOrigin ?? '')) throw new Error('browser origin invalid');
  if (typeof blockNumber !== 'bigint' || blockNumber < 0n) throw new Error('block number invalid');
  const factory = assertAddress(expectedDeployments?.factory, 'Factory');
  const router02 = assertAddress(expectedDeployments?.router02, 'Router');
  const weth9 = assertAddress(expectedDeployments?.weth9, 'WETH');
  let preflight;
  try {
    preflight = await fetch(rpcUrl, {
      method: 'OPTIONS',
      headers: { origin: browserOrigin, 'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type' },
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('RPC browser CORS preflight failed'); }
  checkCors(preflight, browserOrigin);
  const allowedMethods = (preflight.headers.get('access-control-allow-methods') ?? '').toLowerCase().split(/\s*,\s*/);
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
  if (!preflight.ok || !allowedMethods.includes('post') ||
      (!allowedHeaders.includes('content-type') && !allowedHeaders.includes('*'))) {
    throw new Error('RPC browser CORS preflight denied');
  }
  let id = 0;
  async function rpc(method, params = []) {
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: browserOrigin },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(`RPC ${method} transport failed`);
    }
    checkCors(response, browserOrigin);
    if (!response.ok) throw new Error(`RPC ${method} HTTP failure`);
    let body;
    try { body = await response.json(); } catch { throw new Error(`RPC ${method} JSON invalid`); }
    if (body?.error || body?.result === undefined) throw new Error(`RPC ${method} unsupported or failed`);
    return body.result;
  }

  const chain = await rpc('eth_chainId');
  if (chain !== `0x${SEPOLIA_CHAIN_ID.toString(16)}`) throw new Error('Sepolia chain ID mismatch');
  const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized || !hashPattern.test(finalized.hash ?? '') || !/^0x[0-9a-fA-F]+$/.test(finalized.number ?? '')) {
    throw new Error('finalized block unavailable');
  }
  const checkpointNumber = `0x${blockNumber.toString(16)}`;
  if (BigInt(finalized.number) < blockNumber) throw new Error('checkpoint is not finalized');
  const checkpoint = await rpc('eth_getBlockByNumber', [checkpointNumber, false]);
  if (!checkpoint || checkpoint.number?.toLowerCase() !== checkpointNumber || !hashPattern.test(checkpoint.hash ?? '')) {
    throw new Error('checkpoint block invalid');
  }
  const canonical = await rpc('eth_getBlockByHash', [checkpoint.hash, false]);
  if (canonical?.hash?.toLowerCase() !== checkpoint.hash.toLowerCase() ||
      canonical?.number?.toLowerCase() !== checkpointNumber) throw new Error('canonical block hash mismatch');
  const blockRef = { blockHash: checkpoint.hash, requireCanonical: true };
  const balance = await rpc('eth_getBalance', [router02, blockRef]);
  if (!/^0x[0-9a-fA-F]+$/.test(balance ?? '')) throw new Error('historical balance unavailable');
  const logs = await rpc('eth_getLogs', [{ fromBlock: checkpointNumber, toBlock: checkpointNumber }]);
  if (!Array.isArray(logs)) throw new Error('historical logs unavailable');
  for (const [name, target] of [['Factory', factory], ['Router', router02], ['WETH', weth9]]) {
    const code = await rpc('eth_getCode', [target, blockRef]);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code ?? '')) throw new Error(`${name} code unavailable`);
  }
  const readRouter = async (selector, name) => decodeAddress(
    await rpc('eth_call', [{ to: router02, data: selector }, blockRef]), name);
  if (await readRouter('0xc45a0155', 'Router Factory') !== factory) throw new Error('Router Factory mismatch');
  if (await readRouter('0xad5c4648', 'Router WETH') !== weth9) throw new Error('Router WETH mismatch');
  return { chainId: SEPOLIA_CHAIN_ID, finalizedBlockHash: finalized.hash,
    checkpointBlockHash: checkpoint.hash, checkpointBlockNumber: blockNumber.toString(),
    factory, router02, weth9 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { UNISWAP_SEPOLIA_RPC_URL: rpcUrl, UNISWAP_BROWSER_ORIGIN: browserOrigin,
    UNISWAP_SEPOLIA_BLOCK: block } = process.env;
  if (!block || !/^(0|[1-9][0-9]*)$/.test(block)) {
    console.error('Set UNISWAP_SEPOLIA_BLOCK to a finalized decimal block number');
    process.exitCode = 1;
  } else {
    probeSepolia({ rpcUrl, browserOrigin, blockNumber: BigInt(block), expectedDeployments: {
      factory: '0xF62c03E08ada871A0bEb309762E260a7a6a880E6',
      router02: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
      weth9: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    } }).then(result => console.log(JSON.stringify(result, null, 2)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
