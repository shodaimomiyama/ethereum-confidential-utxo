import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { expect, it } from 'vitest';
import { startBrowserLiveEnvironment } from './browser-live-environment.js';

function localRequest(url: string, method = 'GET', body?: unknown): Promise<{ status: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(url, { method, rejectUnauthorized: false,
      headers: bytes ? { 'content-type': 'application/json', origin: new URL(url).origin } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.once('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(bytes);
  });
}

it('serves a pinned live site, RPC and real scoped service from one HTTPS origin', async () => {
  const environment = await startBrowserLiveEnvironment();
  try {
    const page = await localRequest(environment.appUrl);
    expect(page.status).toBe(200);
    expect(page.bytes.toString()).toContain('<div id="root"></div>');
    const config = await localRequest(`${environment.origin}/live-config.json`);
    expect(config.status).toBe(200);
    expect(createHash('sha256').update(config.bytes).digest('hex')).toBe(environment.liveConfigSha256);
    expect(JSON.parse(config.bytes.toString()).rpcUrl).toBe(environment.browserRpcUrl);
    const rpc = await localRequest(environment.browserRpcUrl, 'POST', {
      jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [],
    });
    expect(rpc.status).toBe(200);
    expect(JSON.parse(rpc.bytes.toString()).result).toBe('0x7a69');
    const challenge = await localRequest(`${environment.origin}/v1/auth/challenge`, 'POST', {
      scope: { deploymentId: environment.deploymentId, owner: environment.accountAddress },
    });
    expect(challenge.status, challenge.bytes.toString()).toBe(200);
    expect(JSON.parse(challenge.bytes.toString()).nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  } finally { await environment.close(); }
}, 180_000);
