import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { probeSepolia } from '../../scripts/uniswap-rpc.mjs';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const blockHash = `0x${'ab'.repeat(32)}`;
const factory = address(1);
const router02 = address(2);
const weth9 = address(3);
const padded = value => `0x${'0'.repeat(24)}${value.slice(2)}`;
const deployments = { factory, router02, weth9 };

async function withRpc(overrides, callback) {
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...(overrides.noCors ? {} : { 'access-control-allow-origin': 'https://demo.example' }),
        ...(overrides.noPreflight ? {} : {
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type',
        }),
      });
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const { id, method, params } = JSON.parse(body);
    const block = { number: '0x64', hash: blockHash };
    let result;
    if (method === 'eth_chainId') result = overrides.chainId ?? '0xaa36a7';
    else if (method === 'eth_getBlockByNumber') result = params[0] === 'finalized' && overrides.noFinalized ? null : block;
    else if (method === 'eth_getBlockByHash') result = overrides.wrongBlockHash ? { ...block, hash: `0x${'cd'.repeat(32)}` } : block;
    else if (method === 'eth_getBalance') result = '0x0';
    else if (method === 'eth_getLogs') result = overrides.noLogs ? undefined : [];
    else if (method === 'eth_getCode') result = overrides.noRouterCode && params[0].toLowerCase() === router02 ? '0x' : '0x6001';
    else if (method === 'eth_call') result = params[0].data === '0xc45a0155' ? padded(overrides.wrongFactory ? address(99) : factory) : padded(weth9);
    response.writeHead(200, { 'content-type': 'application/json',
      ...(overrides.noCors ? {} : { 'access-control-allow-origin': 'https://demo.example' }) });
    response.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported' } }
      : { jsonrpc: '2.0', id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    return await callback({ rpcUrl: url, browserOrigin: 'https://demo.example', blockNumber: 100n,
      expectedDeployments: deployments });
  } finally {
    server.close();
  }
}

test('Sepolia probe verifies finalized history, canonical lookup, CORS and official contract references', async () => {
  const result = await withRpc({}, options => probeSepolia(options));
  assert.equal(result.chainId, 11155111);
  assert.equal(result.finalizedBlockHash, blockHash);
  assert.equal(result.router02, router02);
  assert.equal(result.weth9, weth9);
});

for (const [name, overrides, error] of [
  ['wrong chain', { chainId: '0x7a69' }, /chain/i],
  ['missing finalized', { noFinalized: true }, /finalized/i],
  ['wrong block hash', { wrongBlockHash: true }, /block hash|canonical/i],
  ['logs unsupported', { noLogs: true }, /log|unsupported/i],
  ['browser CORS denied', { noCors: true }, /cors/i],
  ['browser CORS preflight denied', { noPreflight: true }, /cors/i],
  ['Router code missing', { noRouterCode: true }, /router|code/i],
  ['Router points at another Factory', { wrongFactory: true }, /factory/i],
]) {
  test(`Sepolia probe rejects ${name}`, async () => {
    await assert.rejects(withRpc(overrides, options => probeSepolia(options)), error);
  });
}
