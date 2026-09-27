import { authorizeOperation, buildOperation, recipientInfoTypedData, toPublicSubmission } from '@confidential-utxo/core';
import type { LocalDraft } from '@confidential-utxo/core';
import { prepareSignedRaw } from '@confidential-utxo/ethereum';
import type { SubmissionWallet } from '@confidential-utxo/ethereum';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ServiceContext } from '../extensions.js';
import { loadEthereumRuntime } from '../ethereum-provider.js';
import { parseRewardSecrets, readRewardFunds } from './crypto.js';
import type { CancellationDraft, CancellationPorts } from './operator.js';
import { loadSavedDraft } from './store.js';

export async function createProductionCancellationPorts(service: ServiceContext, requestId: string): Promise<{
  key: Uint8Array; ports: CancellationPorts;
}> {
  const { deploymentId, deployment, env } = service;
  if (deploymentId === undefined || deployment === undefined || env === undefined) {
    throw new Error('UNKNOWN_DEPLOYMENT');
  }
  const secrets = parseRewardSecrets(env.REWARD_SECRETS_JSON, deploymentId);
  if (secrets === undefined) throw new Error('REWARD_SECRETS_UNAVAILABLE');
  const { history, verified, client } = await loadEthereumRuntime(deploymentId, deployment,
    env.RPC_DEPLOYMENTS_JSON);
  const account = privateKeyToAccount(secrets.ownerPrivateKey);
  const wallet: SubmissionWallet = {
    account,
    getChainId: () => client.getChainId(),
    estimateGas: (args) => client.estimateGas(args),
    estimateFeesPerGas: () => client.estimateFeesPerGas(),
    getBalance: (args) => client.getBalance(args),
    getTransactionCount: (args) => client.getTransactionCount(args),
    sendTransaction: async () => { throw new Error('RAW_ONLY'); },
  };
  const keys = { getKey: async (owner: `0x${string}`) => {
    if (owner.toLowerCase() !== secrets.owner.toLowerCase()) throw new Error('REWARD_OWNER_MISMATCH');
    return secrets.receiptKey;
  } };
  return { key: secrets.stateKey, ports: {
    async build() {
      const old = await loadSavedDraft<LocalDraft>(service.storage, deploymentId, requestId, secrets.stateKey);
      if (old === undefined || old.request.inputIds.length === 0) throw new Error('REWARD_CANCELLATION_CONFLICT');
      const chosenId = old.request.inputIds[0]!;
      const funds = await readRewardFunds(history, keys, secrets.owner);
      if (funds.status !== 'complete') throw new Error('REWARD_FUNDS_UNKNOWN');
      const input = funds.available.find((coin) => coin.id.toLowerCase() === chosenId.toLowerCase());
      if (input === undefined) throw new Error('REWARD_FUNDS_UNKNOWN');
      const context = verified.context;
      const unsigned = { chainId: context.chainId, pool: context.pool, owner: secrets.owner,
        receivePublicKey: bytesToHex(x25519.getPublicKey(secrets.receiptKey)),
        receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
      const signature = await account.signTypedData(recipientInfoTypedData(context, unsigned, secrets.owner));
      const recipient = { ...unsigned, signature };
      const draft = await buildOperation({ kind: 1, owner: secrets.owner,
        amount: input.opening.amount, recipient, explicitIds: [input.id] }, context,
      { inputs: [input], randomSalt: () => crypto.getRandomValues(new Uint8Array(32)) });
      return { operationId: draft.operationId, inputId: input.id, draft };
    },
    async sign(value: CancellationDraft) {
      const draft = value as LocalDraft;
      const signature = await authorizeOperation(draft.context, draft.request,
        { signTypedData: (data) => account.signTypedData(data) });
      return { ...draft, signature };
    },
    async prepare(value: CancellationDraft) {
      const draft = value as LocalDraft;
      const result = await prepareSignedRaw(verified, history, { account, wallet }, toPublicSubmission(draft));
      return { raw: result.raw, hash: result.hash, nonce: result.nonce };
    },
    async broadcast(raw) {
      service.ensureWritable();
      try { await client.sendRawTransaction({ serializedTransaction: raw }); }
      catch { /* Lost RPC acknowledgement does not invalidate stored raw. */ }
    },
    async observe(oldOperationId, cancellationOperationId, inputId) {
      try {
        const point = await history.getFinalizedCheckpoint();
        if (point === null) return 'unknown';
        const [operations, old, cancellation, input] = await Promise.all([
          history.getOperations(verified.context.deploymentBlock, point),
          history.getOperationSuccess(oldOperationId as `0x${string}`, point),
          history.getOperationSuccess(cancellationOperationId as `0x${string}`, point),
          history.getUtxo(inputId as `0x${string}`, point),
        ]);
        if (!operations.complete || !old.complete || !cancellation.complete || !input.complete
          || [operations, old, cancellation, input].some((item) => item.blockHash.toLowerCase()
            !== point.hash.toLowerCase())) return 'unknown';
        if (old.value.executed) return 'old-finalized';
        if (!cancellation.value.executed) return input.value.consumedBy === undefined ? 'none' : 'unknown';
        const observed = operations.value.find((item) => item.success?.operationId.toLowerCase()
          === cancellationOperationId.toLowerCase());
        if (observed?.success === undefined || observed.inputLogs?.some((log) => log.inputId.toLowerCase()
          === inputId.toLowerCase()) !== true || input.value.consumedBy?.toLowerCase()
          !== cancellationOperationId.toLowerCase()) return 'unknown';
        const header = await history.getCanonicalHeader(observed.success.blockNumber, point);
        if (!header.complete || header.blockHash.toLowerCase() !== point.hash.toLowerCase()
          || header.value.hash.toLowerCase() !== observed.success.blockHash.toLowerCase()) return 'unknown';
        return { kind: 'cancel-finalized' as const, checkpointHash: observed.success.blockHash };
      } catch { return 'unknown'; }
    },
  } };
}
