import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { commit } from '@confidential-utxo/crypto';
import { recipientInfoTypedData, verifyRecipientInfo } from '@confidential-utxo/core';
import type { Context, HistoryPort, LocalDraft, OwnedUtxo, ObservedOperation } from '@confidential-utxo/core';
import { encodePoolSubmission } from '@confidential-utxo/ethereum';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { bytesToHex, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { initializeEnvironment } from '../src/recovery.js';
import { makeServiceContext } from '../src/extensions.js';
import { rewardExtension } from '../src/rewards/extension.js';
import { buildAndAuthorizeReward, loadSavedDraft } from '../src/rewards/store.js';
import { broadcastRewardAttempt, listRewardAttempts, prepareAndStoreRewardAttempt } from '../src/rewards/transaction.js';
import type { VerifiedDeployment } from '@confidential-utxo/ethereum';

const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;

it('keeps one real cryptographic transfer draft and signed raw across the SQLite and RPC boundary', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-real-crypto-integration'));
  await stub.fetch('https://site.test/v1/operations');
  const source = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const receiver = privateKeyToAccount(`0x${'02'.repeat(32)}`);
  const context: Context = { chainId: 31337n, pool: `0x${'11'.repeat(20)}`,
    verifier: `0x${'22'.repeat(20)}`, parametersHash: hash('0'), deploymentBlock: 1n,
    finalityMode: 'local-simulated' };
  const key = new Uint8Array(32).fill(7);
  const sourceReceiptKey = new Uint8Array(32).fill(4);
  const receiverReceiptKey = new Uint8Array(32).fill(3);
  const signedRecipient = async (account: typeof source, privateKey: Uint8Array) => {
    const unsigned = { chainId: context.chainId, pool: context.pool, owner: account.address,
      receivePublicKey: bytesToHex(x25519.getPublicKey(privateKey)),
      receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
    return { ...unsigned, signature: await account.signTypedData(
      recipientInfoTypedData(context, unsigned, account.address)) };
  };
  const recipient = await signedRecipient(receiver, receiverReceiptKey);
  const changeRecipient = await signedRecipient(source, sourceReceiptKey);
  await verifyRecipientInfo(context, recipient, receiver.address);
  const opening = { amount: 10n, blinding: 1n };
  const coin: OwnedUtxo = { id: hash('a'), owner: source.address, opening, commitment: commit(opening),
    checkpoint: { number: 1n, hash: hash('b'), mode: 'local-simulated' }, status: 'available',
    chainId: context.chainId, pool: context.pool };
  let point = { number: 1n, hash: hash('b'), mode: 'local-simulated' as const };
  let observed: ObservedOperation | undefined;
  const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => point,
    getContext: async () => bound(context),
    getCanonicalHeader: async (number) => bound({ number, hash: number === 1n ? hash('b') : point.hash }),
    getOperations: async () => bound(observed === undefined ? [] : [observed]),
    getUtxo: async () => bound({ exists: true, owner: source.address, commitment: coin.commitment,
      ...(observed === undefined ? {} : { consumedBy: observed.success!.operationId }) }),
    getOperationSuccess: async () => bound({ executed: observed !== undefined }),
    getLatestHeader: async () => point,
    getLatestUtxo: async () => bound({ exists: true, owner: source.address, commitment: coin.commitment }),
    getLatestOperationSuccess: async () => bound({ executed: false }),
  };
  await runInDurableObject(stub, async (_object, state) => {
    initializeEnvironment(state.storage, { generation: 'test-g1', stopped: false, initialize: true });
    const requestId = hash('c');
    state.storage.sql.exec(`INSERT INTO reward_requests (deployment_id, owner, request_id, amount_wei,
      recipient_info_json, content_hash, status) VALUES ('local-v1', ?, ?, '4', ?, 'hash', 'accepted')`,
    receiver.address.toLowerCase(), requestId, JSON.stringify({ owner: receiver.address,
      publicKey: recipient.receivePublicKey, signature: recipient.signature }));
    state.storage.sql.exec(`INSERT INTO reward_reservations (deployment_id, request_id, amount_wei)
      VALUES ('local-v1', ?, '4')`, requestId);
    const draft = await buildAndAuthorizeReward(state.storage, 'local-v1', requestId, key,
      { kind: 1, owner: source.address, amount: 4n, recipient, changeRecipient }, context, [coin],
      { signTypedData: (data) => source.signTypedData(data) });
    expect(draft).toBeDefined();
    const saved = await loadSavedDraft<LocalDraft>(state.storage, 'local-v1', requestId, key);
    expect(saved?.operationId).toBe(draft!.operationId);
    expect(saved?.request.outputs[0]?.packet).toBe(draft!.request.outputs[0]?.packet);
    expect(encodePoolSubmission({ request: draft!.request, balanceProof: draft!.balanceProof,
      rangeProofs: draft!.rangeProofs, signature: draft!.signature! }).data).toMatch(/^0x[0-9a-f]+$/);
    const rpc = { sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) =>
      keccak256(serializedTransaction)) };
    await expect(broadcastRewardAttempt(state.storage, 'local-v1', requestId, 1, key, rpc))
      .rejects.toThrow();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    const wallet = { account: source, getChainId: async () => 31337,
      estimateGas: async () => 200_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      getBalance: async () => 1_000_000_000n,
      getTransactionCount: async () => 7,
      sendTransaction: async () => { throw new Error('sendTransaction must not run'); } };
    const attemptNo = await prepareAndStoreRewardAttempt(state.storage, 'local-v1', requestId, key,
      { context } as VerifiedDeployment, history, { account: source, wallet },
      { request: draft!.request, balanceProof: draft!.balanceProof,
        rangeProofs: draft!.rangeProofs, signature: draft!.signature! });
    const attempts = await listRewardAttempts(state.storage, 'local-v1', requestId, key);
    expect(attempts[0]?.attemptNo).toBe(attemptNo);
    await broadcastRewardAttempt(state.storage, 'local-v1', requestId, attemptNo, key, rpc);
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: attempts[0]?.raw });
    point = { number: 2n, hash: hash('d'), mode: 'local-simulated' };
    const location = { operationId: draft!.operationId, blockNumber: 2n, blockHash: point.hash,
      transactionHash: hash('e'), transactionIndex: 0 };
    observed = { request: draft!.request,
      success: { ...location, logIndex: 3 },
      inputLogs: [{ ...location, inputId: coin.id, logIndex: 0 }],
      outputLogs: draft!.request.outputs.map((output, index) => ({ ...location,
        output, outputId: draft!.outputIds[index]!, outputIndex: index, logIndex: index + 1 })),
    };
    state.storage.sql.exec(`UPDATE reward_requests SET status = 'finalized', output_id = ?, checkpoint_hash = ?
      WHERE request_id = ?`, draft!.outputIds[0], point.hash, requestId);
    const request = parseApiRequest('POST', `/v1/rewards/${requestId}/received`, {
      scope: { deploymentId: 'local-v1', owner: receiver.address },
      outputId: draft!.outputIds[0], blockHash: point.hash,
    });
    const route = rewardExtension.routes.find((entry) => entry.route === 'POST /v1/rewards/{id}/received')!;
    const result = await route.handle(request, { ...makeServiceContext(state.storage,
      { generation: 'test-g1', stopped: false }, request.scope),
      readRewardHistory: async () => history });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ reward: { status: 'received', requestId } });
  });
});
