import { authorizeOperation, CoreFailure, recipientInfoTypedData,
  selectInputs, toPublicSubmission } from '@confidential-utxo/core';
import type { Context, HistoryPort, LocalDraft, ObservedOperation, ReceiptKeyPort } from '@confidential-utxo/core';
import { prepareSignedRaw } from '@confidential-utxo/ethereum';
import type { RawSigner, SubmissionWallet } from '@confidential-utxo/ethereum';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ServiceContext } from '../extensions.js';
import { loadEthereumRuntime } from '../ethereum-provider.js';
import { buildAndAuthorizeReward, getReward, loadSavedDraft } from './store.js';
import { parseRewardSecrets, readRewardFunds } from './crypto.js';
import { broadcastRewardAttempt, listRewardAttempts, prepareAndStoreRewardAttempt } from './transaction.js';
import type { RewardQueueRunner } from './queue.js';
import { advanceSignedCancellation } from './operator.js';
import { createProductionCancellationPorts } from './operator-production.js';
import { advanceRewardConsolidation, buildConsolidationDraft,
  latestConsolidation } from './consolidation.js';
import { rewardAvailability } from './availability.js';

type Evidence = { kind: 'complete'; observed: ObservedOperation | undefined; pointHash: string }
  | { kind: 'unknown' };

async function findFinalizedOperation(history: HistoryPort, context: Context, operationId: string): Promise<Evidence> {
  try {
    const point = await history.getFinalizedCheckpoint();
    if (point === null || point.mode !== context.finalityMode) return { kind: 'unknown' };
    const all = await history.getOperations(context.deploymentBlock, point);
    if (!all.complete || all.blockHash.toLowerCase() !== point.hash.toLowerCase()) return { kind: 'unknown' };
    const observed = all.value.find((entry) => entry.success?.operationId.toLowerCase() === operationId.toLowerCase());
    if (observed === undefined) return { kind: 'complete', observed: undefined, pointHash: point.hash };
    const success = observed.success!;
    const header = await history.getCanonicalHeader(success.blockNumber, point);
    const executed = await history.getOperationSuccess(operationId as `0x${string}`, point);
    if (!header.complete || header.blockHash.toLowerCase() !== point.hash.toLowerCase()
      || header.value.hash.toLowerCase() !== success.blockHash.toLowerCase()
      || !executed.complete || executed.blockHash.toLowerCase() !== point.hash.toLowerCase()
      || !executed.value.executed || observed.outputLogs.length !== observed.request.outputs.length
      || observed.inputLogs?.length !== observed.request.inputIds.length) return { kind: 'unknown' };
    for (const id of observed.request.inputIds) {
      const state = await history.getUtxo(id, point);
      if (!state.complete || state.blockHash.toLowerCase() !== point.hash.toLowerCase()
        || state.value.consumedBy?.toLowerCase() !== operationId.toLowerCase()) return { kind: 'unknown' };
    }
    return { kind: 'complete', observed, pointHash: point.hash };
  } catch { return { kind: 'unknown' }; }
}

export async function verifyFinalizedCancellation(history: HistoryPort, context: Context,
  oldOperationId: string, cancellationOperationId: string, inputId: string,
  checkpointHash: string): Promise<boolean | undefined> {
  const [old, cancellation] = await Promise.all([
    findFinalizedOperation(history, context, oldOperationId),
    findFinalizedOperation(history, context, cancellationOperationId),
  ]);
  if (old.kind === 'unknown' || cancellation.kind === 'unknown') return undefined;
  if (old.observed !== undefined || cancellation.observed === undefined) return false;
  return cancellation.observed.success?.blockHash.toLowerCase() === checkpointHash.toLowerCase()
    && cancellation.observed.inputLogs?.some((log) => log.inputId.toLowerCase() === inputId.toLowerCase()) === true;
}

export async function createProductionRewardRunner(service: ServiceContext): Promise<RewardQueueRunner> {
  const { deploymentId, deployment, env } = service;
  if (deploymentId === undefined || deployment === undefined || env === undefined) throw new Error('UNKNOWN_DEPLOYMENT');
  const secrets = parseRewardSecrets(env.REWARD_SECRETS_JSON, deploymentId);
  if (secrets === undefined) throw new Error('REWARD_SECRETS_UNAVAILABLE');
  const rewardSecrets = secrets;
  const runtime = await loadEthereumRuntime(deploymentId, deployment, env.RPC_DEPLOYMENTS_JSON);
  const { history, verified, client } = runtime;
  const account = privateKeyToAccount(secrets.ownerPrivateKey);
  const keys: ReceiptKeyPort = { getKey: async (owner) => {
    if (owner.toLowerCase() !== secrets.owner.toLowerCase()) throw new Error('REWARD_OWNER_MISMATCH');
    return secrets.receiptKey;
  } };
  const wallet: SubmissionWallet = {
    account,
    getChainId: () => client.getChainId(),
    estimateGas: (args) => client.estimateGas(args),
    estimateFeesPerGas: () => client.estimateFeesPerGas(),
    getBalance: (args) => client.getBalance(args),
    getTransactionCount: (args) => client.getTransactionCount(args),
    sendTransaction: async () => { throw new Error('RAW_ONLY'); },
  };
  const signer: RawSigner = { account, wallet };
  const rawRpc = { sendRawTransaction: (args: { serializedTransaction: `0x${string}` }) =>
    client.sendRawTransaction(args) };

  function ensureRewardActive(): void {
    service.ensureWritable();
    if (!rewardAvailability(service.storage, service.recoveryGate, deploymentId!).distribute) {
      throw new Error('REWARD_DISTRIBUTION_STOPPED');
    }
  }

  async function submitSaved(requestId: string): Promise<void> {
    const draft = await loadSavedDraft<LocalDraft>(service.storage, deploymentId!, requestId, secrets!.stateKey);
    if (draft?.signature === undefined) throw new Error('REWARD_DRAFT_UNRESOLVED');
    const attemptNo = await prepareAndStoreRewardAttempt(service.storage, deploymentId!, requestId,
      secrets!.stateKey, verified, history, signer, toPublicSubmission(draft), {}, ensureRewardActive);
    ensureRewardActive();
    await broadcastRewardAttempt(service.storage, deploymentId!, requestId, attemptNo, secrets!.stateKey, rawRpc);
  }

  function consolidationPorts(requestId: string) {
    return {
      async build() {
        const funds = await readRewardFunds(history, keys, rewardSecrets.owner);
        if (funds.status !== 'complete') throw new Error('REWARD_FUNDS_UNKNOWN');
        return buildConsolidationDraft(verified.context, account, rewardSecrets.receiptKey,
          funds.available);
      },
      async sign(value: { operationId: string; signature?: string }) {
        const draft = value as LocalDraft;
        const signature = await authorizeOperation(draft.context, draft.request,
          { signTypedData: (data) => account.signTypedData(data) });
        return { ...draft, signature };
      },
      async prepare(value: { operationId: string; signature?: string }) {
        const result = await prepareSignedRaw(verified, history, signer,
          toPublicSubmission(value as LocalDraft));
        return { raw: result.raw, hash: result.hash, nonce: result.nonce };
      },
      async observe(operationId: string, inputIds: string[]) {
        const evidence = await findFinalizedOperation(history, verified.context, operationId);
        if (evidence.kind === 'unknown') return 'unknown' as const;
        if (evidence.observed === undefined) return 'none' as const;
        if (inputIds.some((id) => !evidence.observed!.inputLogs?.some((log) =>
          log.inputId.toLowerCase() === id.toLowerCase()))
          || evidence.observed.outputLogs.some((log) =>
            log.output.owner.toLowerCase() !== rewardSecrets.owner.toLowerCase())) return 'unknown' as const;
        return { kind: 'finalized' as const, checkpointHash: evidence.observed.success!.blockHash };
      },
      async broadcast(raw: `0x${string}`) {
        ensureRewardActive();
        try { await client.sendRawTransaction({ serializedTransaction: raw }); }
        catch { /* A lost acknowledgement leaves the saved raw eligible for reconciliation. */ }
      },
    };
  }

  return {
    async probe() { return (await readRewardFunds(history, keys, secrets.owner)).status === 'complete'; },
    async dispatch(requestId) {
      ensureRewardActive();
      const row = service.storage.sql.exec<{ owner: string; amount_wei: string; recipient_info_json: string }>(
        `SELECT owner, amount_wei, recipient_info_json FROM reward_requests
         WHERE deployment_id = ? AND request_id = ? AND status IN ('accepted', 'queued')`, deploymentId, requestId,
      ).toArray()[0];
      if (row === undefined) return;
      const funds = await readRewardFunds(history, keys, secrets.owner);
      if (funds.status !== 'complete') throw new Error('REWARD_FUNDS_UNKNOWN');
      const observed = await history.getContext(funds.checkpoint);
      if (!observed.complete || observed.blockHash.toLowerCase() !== funds.checkpoint.hash.toLowerCase()) {
        throw new Error('REWARD_FUNDS_UNKNOWN');
      }
      const context = observed.value;
      if (context.chainId !== verified.context.chainId || context.pool.toLowerCase() !== verified.context.pool.toLowerCase()) {
        throw new Error('REWARD_FUNDS_UNKNOWN');
      }
      const amount = BigInt(row.amount_wei);
      const maintenance = latestConsolidation(service.storage, deploymentId, requestId);
      if (maintenance !== undefined && maintenance.phase !== 'finalized') {
        await advanceRewardConsolidation(service.storage, deploymentId, requestId,
          secrets.stateKey, consolidationPorts(requestId), false, ensureRewardActive);
        return;
      }
      try { selectInputs(context, funds.available, { kind: 1, owner: secrets.owner, amount }); }
      catch (error) {
        if (!(error instanceof CoreFailure) || error.code !== 'UNCONSTRUCTABLE') throw error;
        await advanceRewardConsolidation(service.storage, deploymentId, requestId,
          secrets.stateKey, consolidationPorts(requestId), maintenance?.phase === 'finalized',
          ensureRewardActive);
        return;
      }
      const user = JSON.parse(row.recipient_info_json) as { owner: `0x${string}`;
        publicKey: `0x${string}`; signature: `0x${string}` };
      const recipient = { chainId: context.chainId, pool: context.pool, owner: user.owner,
        receivePublicKey: user.publicKey, receiptFormat: 1 as const, recipientInfoVersion: 1 as const,
        signature: user.signature };
      const changeUnsigned = { chainId: context.chainId, pool: context.pool, owner: secrets.owner,
        receivePublicKey: bytesToHex(x25519.getPublicKey(secrets.receiptKey)),
        receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
      const changeSignature = await account.signTypedData(recipientInfoTypedData(context, changeUnsigned, secrets.owner));
      const changeRecipient = { ...changeUnsigned, signature: changeSignature };
      const draft = await buildAndAuthorizeReward(service.storage, deploymentId, requestId, secrets.stateKey,
        { kind: 1, owner: secrets.owner, amount, recipient, changeRecipient }, context, funds.available,
        { signTypedData: (data) => account.signTypedData(data) }, ensureRewardActive);
      if (draft === undefined) return;
      await submitSaved(requestId);
    },
    async reconcile(requestId) {
      const cancellation = service.storage.sql.exec<{ phase: string }>(
        `SELECT phase FROM reward_cancellations WHERE deployment_id = ? AND request_id = ?`,
        deploymentId, requestId,
      ).toArray()[0];
      if (cancellation !== undefined) {
        const { key, ports } = await createProductionCancellationPorts(service, requestId);
        try {
          await advanceSignedCancellation(service.storage, deploymentId, requestId,
            { authorized: true }, key, ports);
          return;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'ORIGINAL_FINALIZED') throw error;
        }
      }
      const row = service.storage.sql.exec<{ status: string; operation_id: string | null; state_version: number }>(
        `SELECT status, operation_id, state_version FROM reward_requests
         WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId,
      ).toArray()[0];
      if (row === undefined || row.operation_id === null) return;
      const evidence = await findFinalizedOperation(history, verified.context, row.operation_id);
      if (evidence.kind === 'unknown') throw new Error('REWARD_FUNDS_UNKNOWN');
      if (evidence.observed !== undefined) {
        const success = evidence.observed.success!;
        const output = evidence.observed.outputLogs[0];
        if (output === undefined) return;
        service.storage.transactionSync(() => {
          const current = service.storage.sql.exec<{ state_version: number; status: string }>(
            `SELECT state_version, status FROM reward_requests WHERE deployment_id = ? AND request_id = ?`,
            deploymentId, requestId,
          ).toArray()[0];
          if (current?.state_version !== row.state_version || !['pending', 'unknown'].includes(current.status)) return;
          service.storage.sql.exec(`UPDATE reward_requests SET status = 'finalized', checkpoint_hash = ?,
            output_id = ?, state_version = state_version + 1 WHERE deployment_id = ? AND request_id = ?`,
          success.blockHash, output.outputId, deploymentId, requestId);
          service.storage.sql.exec(`UPDATE reward_reservations SET released = 1
            WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
          service.storage.sql.exec(`UPDATE reward_inputs SET status = 'consumed'
            WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId);
        });
        return;
      }
      if (row.status === 'processing') {
        const draft = await loadSavedDraft<LocalDraft>(service.storage, deploymentId, requestId, secrets.stateKey);
        if (draft?.signature !== undefined) await submitSaved(requestId);
        return;
      }
      const attempts = await listRewardAttempts(service.storage, deploymentId, requestId, secrets.stateKey);
      if (attempts.length > 0) {
        service.ensureWritable();
        await broadcastRewardAttempt(service.storage, deploymentId, requestId,
          attempts.at(-1)!.attemptNo, secrets.stateKey, rawRpc);
      }
    },
    async verifyFinalized(requestId, checkpointHash) {
      const row = service.storage.sql.exec<{ operation_id: string | null }>(
        `SELECT operation_id FROM reward_requests WHERE deployment_id = ? AND request_id = ?`, deploymentId, requestId,
      ).toArray()[0];
      if (row?.operation_id === null || row === undefined) return undefined;
      const evidence = await findFinalizedOperation(history, verified.context, row.operation_id);
      if (evidence.kind === 'unknown') return undefined;
      return evidence.observed?.success?.blockHash.toLowerCase() === checkpointHash.toLowerCase();
    },
    async verifyCancellationFinalized(requestId, checkpointHash) {
      const row = service.storage.sql.exec<{ operation_id: string; input_id: string;
        old_operation_id: string | null }>(`SELECT c.operation_id, c.input_id,
          r.operation_id AS old_operation_id FROM reward_cancellations c JOIN reward_requests r
          ON r.deployment_id = c.deployment_id AND r.request_id = c.request_id
          WHERE c.deployment_id = ? AND c.request_id = ?`, deploymentId, requestId).toArray()[0];
      if (row?.old_operation_id === null || row === undefined) return undefined;
      return verifyFinalizedCancellation(history, verified.context, row.old_operation_id,
        row.operation_id, row.input_id, checkpointHash);
    },
    async verifyConsolidationFinalized(requestId, operationId, inputIds, checkpointHash) {
      const evidence = await findFinalizedOperation(history, verified.context, operationId);
      if (evidence.kind === 'unknown') return undefined;
      return evidence.observed?.success?.blockHash.toLowerCase() === checkpointHash.toLowerCase()
        && inputIds.every((id) => evidence.observed?.inputLogs?.some((log) =>
          log.inputId.toLowerCase() === id.toLowerCase()) === true);
    },
  };
}
