import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { buildOperation, inspectReceipt, recipientInfoTypedData, type Context, type HistoryPort, type ObservedOperation } from '@confidential-utxo/core';
import type { RequestId, Scope } from '@confidential-utxo/uniswap';
import { bytesToHex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import worker, { type ServiceEnv } from '../src/index.js';
import type { UniswapServiceObject } from '../src/durable-object.js';
import { registerCoreHistoryProvider } from '../src/core-reader.js';
import { rewardAvailability, setRewardAvailability } from '../src/rewards/availability.js';
import { createHttpClient } from '../../uniswap-web/src/live/http.js';
import { createScopedRewardClient, RewardRequestUncertain } from '../../uniswap-web/src/live/reward-client.js';
import type { OperationContext } from '../../uniswap-web/src/live/operations.js';

const serviceEnv = env as unknown as ServiceEnv;
const pool = '0x0000000000000000000000000000000000000001' as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const operator = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const wallet = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const receiptKey = new Uint8Array(32).fill(4);
const walletKey = new Uint8Array(32).fill(3);
const point = { number: 10n, hash: hash('a'), mode: 'finalized' as const };
const context: Context = { chainId: 31337n, pool, deploymentBlock: 1n, verifier: pool,
  parametersHash: hash('0'), finalityMode: 'finalized' };
const scope = { deploymentId: 'local-v1', owner: wallet.address } as Scope;
const requestId = hash('b') as RequestId;
const distinctId = hash('c') as RequestId;
const EdgeRequest = Request;

beforeAll(() => {
  // Workerd lacks redirect:error, while the web client constructs that browser option.
  vi.stubGlobal('Request', class extends EdgeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, { ...init, redirect: init?.redirect === 'error' ? 'manual' : init?.redirect });
    }
  });
});
afterAll(() => vi.unstubAllGlobals());

async function signedRecipient(account: typeof wallet, privateKey: Uint8Array) {
  const unsigned = { chainId: context.chainId, pool, owner: account.address,
    receivePublicKey: bytesToHex(x25519.getPublicKey(privateKey)),
    receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
  return { ...unsigned, signature: await account.signTypedData(
    recipientInfoTypedData(context, unsigned, account.address)) };
}

async function session(account: typeof wallet): Promise<string> {
  const ownedScope = { deploymentId: 'local-v1', owner: account.address };
  const challengeResponse = await worker.fetch(new Request('https://site.test/v1/auth/challenge', {
    method: 'POST', headers: { origin: 'https://site.test' }, body: JSON.stringify({ scope: ownedScope }),
  }), serviceEnv);
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json() as { challengeId: string; nonce: string; issuedAt: number; expiresAt: number };
  const siweMessage = createSiweMessage({ address: account.address, domain: 'site.test', uri: 'https://site.test/',
    version: '1', chainId: 31337, nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expiresAt) });
  const response = await worker.fetch(new Request('https://site.test/v1/auth/verify', {
    method: 'POST', headers: { origin: 'https://site.test' }, body: JSON.stringify({ scope: ownedScope,
      challengeId: challenge.challengeId, siweMessage, signature: await account.signMessage({ message: siweMessage }) }),
  }), serviceEnv);
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

it('recovers a lost reward POST ACK through authenticated Workerd HTTP and accepts receipt only after core inspection', async () => {
  const stub = serviceEnv.UNISWAP_STATE.get(serviceEnv.UNISWAP_STATE.idFromName('local-v1'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, async object => {
    await (object as UniswapServiceObject).initializeForDeployment('local-v1');
    // Test-only operator secret; production still obtains this from the Worker secret binding.
    Reflect.set(object, 'env', { ...serviceEnv, REWARD_SECRETS_JSON: JSON.stringify({ 'local-v1': {
      stateKey: hash('1'), receiptKey: bytesToHex(receiptKey), ownerPrivateKey: `0x${'01'.repeat(32)}` } }) });
  });
  const operatorRecipient = await signedRecipient(operator, receiptKey);
  const draft = await buildOperation({ kind: 0, owner: operator.address, amount: 10n,
    recipient: operatorRecipient }, context, { inputs: [], randomSalt: () => new Uint8Array(32).fill(7) });
  const location = { operationId: draft.operationId, blockNumber: point.number, blockHash: point.hash,
    transactionHash: hash('d'), transactionIndex: 0 };
  const observed: ObservedOperation = { request: draft.request,
    success: { ...location, logIndex: 1 }, inputLogs: [],
    outputLogs: [{ ...location, logIndex: 0, output: draft.request.outputs[0]!,
      outputId: draft.outputIds[0]!, outputIndex: 0 }] };
  const bound = <T,>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  const operations: ObservedOperation[] = [observed];
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => point,
    getContext: async () => bound(context),
    getOperations: async () => bound(operations),
    getCanonicalHeader: async () => bound({ number: point.number, hash: point.hash }),
    getOperationSuccess: async id => bound({ executed: true,
      operation: operations.find(item => item.success?.operationId === id)!.request }),
    getUtxo: async id => {
      const output = operations.flatMap(item => item.outputLogs).find(item => item.outputId === id)!;
      const consuming = operations.find(item => item.request.inputIds.includes(id));
      return bound({ exists: true, owner: output.output.owner, commitment: output.output.commitment,
        ...(consuming === undefined ? {} : { consumedBy: consuming.success!.operationId }) });
    },
    getLatestHeader: async () => point,
    getLatestUtxo: async () => bound({ exists: true, owner: operator.address, commitment: draft.request.outputs[0]!.commitment }),
    getLatestOperationSuccess: async () => bound({ executed: true }),
  };
  registerCoreHistoryProvider(() => history);
  const cookie = await session(wallet);
  const otherCookie = await session(other);
  let dropAck = true;
  const seen: string[] = [];
  const http = createHttpClient({ origin: 'https://site.test', transport: async request => {
    const headers = new Headers(request.headers);
    headers.set('cookie', cookie);
    if (request.method !== 'GET') headers.set('origin', 'https://site.test');
    const response = await worker.fetch(new Request(request, { headers }), serviceEnv);
    seen.push(`${request.method} ${new URL(request.url).pathname}: ${response.status}`);
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/rewards' && response.ok && dropAck) {
      dropAck = false;
      throw new Error('ACK_LOST_AFTER_COMMIT');
    }
    return response;
  } });
  const recipient = await signedRecipient(wallet, walletKey);
  const operationContext = { scope, epoch: 1, check: () => {}, recipientInfo: () => recipient,
    typedSign: async (data: Parameters<typeof wallet.signTypedData>[0]) => ({
      value: await wallet.signTypedData(data), scope, epoch: 1 }),
  } as unknown as OperationContext;
  const client = createScopedRewardClient({ context: operationContext, http,
    auth: { isAuthenticated: () => true }, resolveDeployment: () => ({ deploymentId: scope.deploymentId,
      chainId: 31337n, pool, adapter: `0x${'22'.repeat(20)}`, origin: 'https://site.test', siweUri: 'https://site.test/' }) });

  await expect(client.request('4', requestId)).rejects.toMatchObject({ name: RewardRequestUncertain.name, requestId });
  expect((await client.recheck(requestId)).status).toBe('accepted');
  expect((await client.list()).map(item => item.requestId)).toEqual([requestId]);
  expect((await client.request('4', requestId)).requestId).toBe(requestId);
  await expect(client.request('4', distinctId)).rejects.toMatchObject({ kind: 'api', code: 'PENDING_REQUEST' });
  expect(seen).toContain('POST /v1/rewards: 200');
  expect(seen).toContain('POST /v1/rewards: 409');
  await runInDurableObject(stub, (_object, state) => {
    expect(state.storage.sql.exec<{ request_id: string }>('SELECT request_id FROM reward_requests').toArray())
      .toEqual([{ request_id: requestId }]);
    expect(state.storage.sql.exec<{ amount_wei: string }>('SELECT amount_wei FROM reward_reservations').toArray())
      .toEqual([{ amount_wei: '4' }]);
  });

  const withoutCookie = await worker.fetch(new Request(`https://site.test/v1/rewards/${requestId}?deploymentId=local-v1&owner=${wallet.address}`), serviceEnv);
  expect(withoutCookie.status).toBe(401);
  const wrongScope = await worker.fetch(new Request(`https://site.test/v1/rewards/${requestId}?deploymentId=local-v1&owner=${wallet.address}`, {
    headers: { cookie: otherCookie },
  }), serviceEnv);
  expect(wrongScope.status).toBe(403);
  const otherScope = await worker.fetch(new Request(`https://site.test/v1/rewards/${requestId}?deploymentId=local-v1&owner=${other.address}`, {
    headers: { cookie: otherCookie },
  }), serviceEnv);
  expect(otherScope.status).toBe(404);

  // A controlled finalized HistoryPort stands in for Pool logs. The transfer is
  // built with core cryptography; no transaction is submitted to a real chain.
  const sourceReceipt = await inspectReceipt(observed, 0, operator.address,
    { getKey: async () => receiptKey }, {
      context, creationBlock: bound({ number: point.number, hash: point.hash }),
      operation: bound({ executed: true, operation: draft.request }),
      utxo: bound({ exists: true, owner: operator.address,
        commitment: draft.request.outputs[0]!.commitment }),
    }, point);
  expect(sourceReceipt).toHaveProperty('utxo');
  if (!('utxo' in sourceReceipt)) throw new Error('fixture receipt failed inspection');
  const transfer = await buildOperation({ kind: 1, owner: operator.address, amount: 4n,
    recipient, changeRecipient: operatorRecipient }, context, {
    inputs: [sourceReceipt.utxo], randomSalt: () => new Uint8Array(32).fill(8),
  });
  const transferLocation = { operationId: transfer.operationId, blockNumber: point.number,
    blockHash: point.hash, transactionHash: hash('e'), transactionIndex: 1 };
  const transferred: ObservedOperation = { request: transfer.request,
    inputLogs: [{ ...transferLocation, inputId: draft.outputIds[0]!, logIndex: 2 }],
    outputLogs: transfer.request.outputs.map((output, index) => ({ ...transferLocation,
      output, outputId: transfer.outputIds[index]!, outputIndex: index, logIndex: index + 3 })),
    success: { ...transferLocation, logIndex: 5 },
  };
  operations.push(transferred);
  const ownerOutput = transferred.outputLogs[0]!;
  const inspected = await inspectReceipt(transferred, 0, wallet.address,
    { getKey: async () => walletKey }, {
      context, creationBlock: bound({ number: point.number, hash: point.hash }),
      operation: bound({ executed: true, operation: transfer.request }),
      utxo: bound({ exists: true, owner: wallet.address,
        commitment: ownerOutput.output.commitment }),
    }, point);
  expect(inspected).toHaveProperty('utxo');
  if (!('utxo' in inspected)) throw new Error('fixture transfer failed inspection');
  await runInDurableObject(stub, async (_object, state) => {
    // Emulates finalized publication of the controlled transfer, not chain finality.
    // The automatic alarm has no RPC deployment in this fixture and may stop
    // distribution; reset only its test-owned stop before checking receive.
    await state.storage.deleteAlarm();
    state.storage.sql.exec("DELETE FROM reward_stop_flags WHERE deployment_id = 'local-v1'");
    setRewardAvailability(state.storage, 'local-v1', 'healthy');
    state.storage.sql.exec(`UPDATE reward_requests SET status = 'finalized',
      operation_id = ?, output_id = ?, checkpoint_hash = ? WHERE request_id = ?`,
    transfer.operationId, ownerOutput.outputId, point.hash, requestId);
    expect(rewardAvailability(state.storage, { generation: 'test-g1', stopped: false }, 'local-v1').reason)
      .toBe('healthy');
  });
  await expect(client.markReceived(requestId, { ...inspected,
    utxo: { ...inspected.utxo, opening: { ...inspected.utxo.opening, amount: 5n } },
  })).rejects.toThrow('RECEIPT_MISMATCH');
  expect((await client.markReceived(requestId, inspected)).status).toBe('received');
  expect((await client.recheck(requestId)).status).toBe('received');
});
