import { expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recipientInfoTypedData, type ReceivedUtxo } from '@confidential-utxo/core';
import type { DeploymentId, RequestId } from '@confidential-utxo/uniswap';
import { HttpFailure, type HttpClient } from '../../src/live/http.js';
import { createScopedRewardClient } from '../../src/live/reward-client.js';
import type { OperationContext } from '../../src/live/operations.js';

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const scope = { deploymentId: 'local-v1' as DeploymentId, owner: account.address } as const;
const pool = `0x${'44'.repeat(20)}` as const;
const key = `0x${'55'.repeat(32)}` as const;
const requestId = `0x${'66'.repeat(32)}` as RequestId;
const outputId = `0x${'88'.repeat(32)}`;
const blockHash = `0x${'99'.repeat(32)}`;
const operationId = `0x${'aa'.repeat(32)}`;
const receipt = { status: 'available', operationId, utxo: { id: outputId, owner: scope.owner, chainId: 31337n, pool,
  status: 'available' }, creationCheckpoint: { number: 10n, hash: blockHash, mode: 'finalized' } } as ReceivedUtxo;
const info = { chainId: 31337n, pool, owner: account.address, receivePublicKey: key, receiptFormat: 1, recipientInfoVersion: 1 } as const;
const record = (signature: `0x${string}`) => ({ scope, requestId, amountWei: 7n, recipientInfo: { owner: scope.owner, publicKey: key, signature }, status: 'accepted' as const, attemptIds: [], txHashes: [] });

function fixture(options: { signer?: typeof account | typeof other; response?: 'lost' | 'accepted' | 'drift' | 'wrong-wire' | 'committed-503' | 'pending-request' | 'conflict' | 'finalized' | 'received-drift' | 'received-wrong-wire' } = {}) {
  let epoch = 1;
  let authenticated = true;
  let deployment = { deploymentId: scope.deploymentId, chainId: 31337n, pool,
    adapter: `0x${'77'.repeat(20)}` as `0x${string}`, origin: 'https://example.test', siweUri: 'https://example.test/' };
  const signer = options.signer ?? account;
  let signature = '' as `0x${string}`;
  const call = vi.fn(async (route: string, input: { body?: { recipientInfo?: { signature: `0x${string}` }; outputId?: string; blockHash?: string } }) => {
    if (route === 'POST /v1/rewards') {
      signature = input.body!.recipientInfo!.signature;
      if (options.response === 'lost') throw new Error('network');
      if (options.response === 'committed-503') throw new HttpFailure('api', 'SERVICE_UNAVAILABLE');
      if (options.response === 'pending-request') throw new HttpFailure('api', 'PENDING_REQUEST');
      if (options.response === 'conflict') throw new HttpFailure('api', 'REQUEST_CONFLICT');
      if (options.response === 'drift') epoch = 2;
      if (options.response === 'wrong-wire') return { reward: { ...record(signature), recipientInfo: { ...record(signature).recipientInfo, publicKey: `0x${'88'.repeat(32)}` } } };
      return { reward: record(signature) };
    }
    if (route === 'GET /v1/rewards/{id}') return { reward: ['finalized', 'received-drift', 'received-wrong-wire'].includes(options.response ?? '')
      ? { ...record(signature), status: 'finalized', outputId, blockHash, operationId } : record(signature) };
    if (route === 'POST /v1/rewards/{id}/received') {
      if (options.response === 'received-drift') epoch = 2;
      return { reward: { ...record(signature), status: 'received', outputId,
        blockHash: options.response === 'received-wrong-wire' ? `0x${'aa'.repeat(32)}` : blockHash, operationId } };
    }
    return { rewards: [record(signature)] };
  });
  const context = { scope, epoch: 1, check: () => { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); },
    recipientInfo: () => info,
    typedSign: async (data: unknown, purpose: string) => {
      expect(purpose).toBe('recipient-info');
      return { value: await signer.signTypedData(data as Parameters<typeof signer.signTypedData>[0]), scope, epoch: 1 };
    },
  } as unknown as OperationContext;
  const client = createScopedRewardClient({ context, http: { call } as unknown as HttpClient,
    auth: { isAuthenticated: () => authenticated }, resolveDeployment: () => deployment });
  return { client, call, setEpoch: (value: number) => { epoch = value; },
    setAuthenticated: (value: boolean) => { authenticated = value; },
    setDeployment: (value: typeof deployment) => { deployment = value; } };
}

it('signs canonical core RecipientInfo and posts the fixed #53 wire once', async () => {
  const { client, call } = fixture();
  const reward = await client.request('7', requestId);
  expect(reward.status).toBe('accepted');
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0]?.[0]).toBe('POST /v1/rewards');
  const body = call.mock.calls[0]?.[1].body;
  expect(body).toMatchObject({ scope, requestId, amountWei: '7', recipientInfo: { owner: scope.owner, publicKey: key } });
  expect(Object.keys(body!.recipientInfo!).sort()).toEqual(['owner', 'publicKey', 'signature']);
  const expected = recipientInfoTypedData({ chainId: 31337n, pool }, info, scope.owner);
  expect(await account.signTypedData(expected)).toBe(body?.recipientInfo?.signature);
});

it('refuses unauthenticated, malformed amount and malformed ID before signing or sending', async () => {
  const { client, call, setAuthenticated } = fixture();
  await expect(client.request('0', requestId)).rejects.toThrow();
  await expect(client.request('01', requestId)).rejects.toThrow();
  await expect(client.request('7', 'bad' as typeof requestId)).rejects.toThrow();
  setAuthenticated(false);
  await expect(client.request('7', requestId)).rejects.toThrow('UNAUTHENTICATED');
  expect(call).not.toHaveBeenCalled();
});

it('rejects wrong owner signature and deployment drift before POST', async () => {
  const wrong = fixture({ signer: other });
  await expect(wrong.client.request('7', requestId)).rejects.toThrow();
  expect(wrong.call).not.toHaveBeenCalled();
  const drift = fixture();
  drift.setDeployment({ deploymentId: scope.deploymentId, chainId: 1n, pool,
    adapter: `0x${'77'.repeat(20)}`, origin: 'https://example.test', siweUri: 'https://example.test/' });
  await expect(drift.client.request('7', requestId)).rejects.toThrow('SCOPE_CHANGED');
  expect(drift.call).not.toHaveBeenCalled();
});

it('keeps requestId after lost ACK and uses GET without another POST', async () => {
  const { client, call } = fixture({ response: 'lost' });
  await expect(client.request('7', requestId)).rejects.toMatchObject({ requestId });
  expect((await client.recheck(requestId)).requestId).toBe(requestId);
  expect((await client.list())[0]?.requestId).toBe(requestId);
  expect(call.mock.calls.map(([route]) => route)).toEqual(['POST /v1/rewards', 'GET /v1/rewards/{id}', 'GET /v1/rewards']);
});

it('preserves committed request ID after 503 and recovers by same-ID GET', async () => {
  const { client, call } = fixture({ response: 'committed-503' });
  await expect(client.request('7', requestId)).rejects.toMatchObject({ requestId });
  expect((await client.recheck(requestId)).requestId).toBe(requestId);
  expect(call.mock.calls.map(([route]) => route)).toEqual(['POST /v1/rewards', 'GET /v1/rewards/{id}']);
});

it('preserves pending request ID for recovery and keeps definitive conflict', async () => {
  const pending = fixture({ response: 'pending-request' });
  await expect(pending.client.request('7', requestId)).rejects.toMatchObject({ requestId });
  expect((await pending.client.list())[0]?.requestId).toBe(requestId);
  const conflict = fixture({ response: 'conflict' });
  await expect(conflict.client.request('7', requestId)).rejects.toMatchObject({ kind: 'api', code: 'REQUEST_CONFLICT' });
  expect(conflict.call).toHaveBeenCalledTimes(1);
});

it('posts core receipt evidence only for the matching finalized reward', async () => {
  const { client, call } = fixture({ response: 'finalized' });
  const result = await client.markReceived(requestId, receipt);
  expect(result.status).toBe('received');
  expect(call.mock.calls.map(([route]) => route)).toEqual(['GET /v1/rewards/{id}', 'POST /v1/rewards/{id}/received']);
  expect(call.mock.calls[1]?.[1].body).toEqual({ scope, outputId, blockHash });
});

it('refuses mismatched or unverified receipt before received POST', async () => {
  const wrong = fixture({ response: 'finalized' });
  await expect(wrong.client.markReceived(requestId, { ...receipt, utxo: { ...receipt.utxo, owner: other.address } })).rejects.toThrow();
  expect(wrong.call).not.toHaveBeenCalled();
  const unfinalized = fixture();
  await expect(unfinalized.client.markReceived(requestId, receipt)).rejects.toThrow();
  expect(unfinalized.call.mock.calls.map(([route]) => route)).toEqual(['GET /v1/rewards/{id}']);
});

it.each(['received-drift', 'received-wrong-wire'] as const)('does not accept an unusable received reply: %s', async response => {
  const { client, call } = fixture({ response });
  await expect(client.markReceived(requestId, receipt)).rejects.toMatchObject({ requestId });
  expect(call.mock.calls.map(([route]) => route)).toEqual(['GET /v1/rewards/{id}', 'POST /v1/rewards/{id}/received']);
});

it.each(['drift', 'wrong-wire'] as const)('keeps requestId when the POST reply is unusable: %s', async response => {
  const { client, call } = fixture({ response });
  await expect(client.request('7', requestId)).rejects.toMatchObject({ requestId });
  expect(call).toHaveBeenCalledTimes(1);
});

it('rejects an A to B to A epoch change', async () => {
  const { client, call, setEpoch } = fixture();
  setEpoch(2); setEpoch(3);
  await expect(client.request('7', requestId)).rejects.toThrow('SCOPE_CHANGED');
  expect(call).not.toHaveBeenCalled();
});

it('does not send after the account changes during recipient signature', async () => {
  let epoch = 1;
  const call = vi.fn();
  const context = { scope, epoch: 1, check: () => { if (epoch !== 1) throw new Error('SCOPE_CHANGED'); },
    recipientInfo: () => info,
    typedSign: async (data: unknown) => {
      const signature = await account.signTypedData(data as Parameters<typeof account.signTypedData>[0]);
      epoch = 2;
      return { value: signature, scope, epoch: 1 };
    },
  } as unknown as OperationContext;
  const client = createScopedRewardClient({ context, http: { call } as unknown as HttpClient,
    auth: { isAuthenticated: () => true }, resolveDeployment: () => ({ deploymentId: scope.deploymentId,
      chainId: 31337n, pool, adapter: `0x${'77'.repeat(20)}`, origin: 'https://example.test', siweUri: 'https://example.test/' }) });
  await expect(client.request('7', requestId)).rejects.toThrow('SCOPE_CHANGED');
  expect(call).not.toHaveBeenCalled();
});
