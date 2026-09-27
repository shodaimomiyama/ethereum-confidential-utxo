import { DurableObject } from 'cloudflare:workers';
import { applyMigrations } from './schema.js';
import type { ServiceEnv } from './index.js';
import { parseApiRequest } from '@confidential-utxo/uniswap';
import { createChallenge, readSessionIdentity, verifyChallenge } from './auth.js';
import { parseDeploymentCatalog, resolveDeployment } from './config.js';
import { apiError, apiSuccess, BodyTooLarge, readLimitedJson } from './http.js';
import { asReservation, getOperation, listOperations, putOperation, releaseOperation } from './store.js';
import { ensureWritable, getAvailability, initializeEnvironment, resolveRecoveryGate } from './recovery.js';
import { getServiceExtensions, makeServiceContext, registerServiceExtension } from './extensions.js';
import { createCoreInputReader, getCoreHistoryProvider } from './core-reader.js';
import { loadEthereumHistory } from './ethereum-provider.js';
import { rewardExtension } from './rewards/extension.js';
import { parseRewardSecrets, readRewardFunds } from './rewards/crypto.js';
import { advanceSignedCancellation, endUndistributedReward } from './rewards/operator.js';
import { createProductionCancellationPorts } from './rewards/operator-production.js';
import { rewardAvailability, resumeRewardAvailability, setRewardAvailability } from './rewards/availability.js';
import type { RewardResumeEvidence } from './rewards/availability.js';
import { loadEthereumRuntime } from './ethereum-provider.js';
import { listRewardAttempts } from './rewards/transaction.js';
import { decryptRewardState } from './rewards/crypto.js';
import { hexToBytes, parseTransaction } from 'viem';
import { encodePoolSubmission } from '@confidential-utxo/ethereum';
import { toPublicSubmission } from '@confidential-utxo/core';
import type { LocalDraft } from '@confidential-utxo/core';
import { loadSavedDraft } from './rewards/store.js';

registerServiceExtension(rewardExtension);

export class UniswapServiceObject extends DurableObject<ServiceEnv> {
  constructor(ctx: DurableObjectState, env: ServiceEnv) {
    super(ctx, env);
    applyMigrations(ctx.storage, getServiceExtensions().flatMap((extension) => extension.migrations));
  }

  // Internal DO RPC for #60's operator-only bootstrap. No HTTP route calls this.
  async initializeForDeployment(deploymentId: string): Promise<void> {
    resolveDeployment(deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
    const gate = resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId);
    const bound = await this.ctx.storage.get<string>('deploymentId');
    if (bound !== undefined && bound !== deploymentId) throw new Error('SCOPE_MISMATCH');
    if (bound === undefined) await this.ctx.storage.put('deploymentId', deploymentId);
    initializeEnvironment(this.ctx.storage, gate);
  }

  // Internal DO RPC for an operator-controlled Worker. Never exposed by fetch().
  private async authorizeRewardOperator(deploymentId: string, operatorToken: string): Promise<void> {
    const expected = this.env.REWARD_OPERATOR_TOKEN;
    if (expected === undefined || expected.length < 32 || operatorToken.length !== expected.length) {
      throw new Error('OPERATOR_UNAUTHORIZED');
    }
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(value)));
    const [left, right] = await Promise.all([digest(expected), digest(operatorToken)]);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
    if (difference !== 0) throw new Error('OPERATOR_UNAUTHORIZED');
    resolveDeployment(deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
    const bound = await this.ctx.storage.get<string>('deploymentId');
    if (bound !== deploymentId) throw new Error('SCOPE_MISMATCH');
    ensureWritable(this.ctx.storage, resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId));
  }

  async endUnsignedRewardForDeployment(deploymentId: string, requestId: string,
    operatorToken: string): Promise<void> {
    await this.authorizeRewardOperator(deploymentId, operatorToken);
    await endUndistributedReward(this.ctx.storage, deploymentId, requestId, { authorized: true });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async cancelSignedRewardForDeployment(deploymentId: string, requestId: string,
    operatorToken: string): Promise<void> {
    await this.authorizeRewardOperator(deploymentId, operatorToken);
    const config = resolveDeployment(deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
    const context = makeServiceContext(this.ctx.storage, resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId),
      undefined, { deploymentId, deployment: config, env: this.env });
    const { key, ports } = await createProductionCancellationPorts(context, requestId);
    await advanceSignedCancellation(this.ctx.storage, deploymentId, requestId, { authorized: true }, key, ports);
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  async resumeRewardForDeployment(deploymentId: string, operatorToken: string,
    operatorEvidence: Pick<RewardResumeEvidence, 'recordsComplete' | 'chainReconciled'> = {}): Promise<void> {
    await this.authorizeRewardOperator(deploymentId, operatorToken);
    const gate = resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId);
    const config = resolveDeployment(deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
    const reason = rewardAvailability(this.ctx.storage, gate, deploymentId).reason;
    const secrets = parseRewardSecrets(this.env.REWARD_SECRETS_JSON, deploymentId);
    if (secrets === undefined) throw new Error('REWARD_RESUME_EVIDENCE');
    const runtime = await loadEthereumRuntime(deploymentId, config, this.env.RPC_DEPLOYMENTS_JSON);
    const funds = await readRewardFunds(runtime.history, { getKey: async (owner) => {
      if (owner.toLowerCase() !== secrets.owner.toLowerCase()) throw new Error('REWARD_OWNER_MISMATCH');
      return secrets.receiptKey;
    } }, secrets.owner);
    if (funds.status !== 'complete') throw new Error('REWARD_RESUME_EVIDENCE');
    const activeReserved = this.ctx.storage.sql.exec<{ amount_wei: string }>(
      'SELECT amount_wei FROM reward_reservations WHERE deployment_id = ? AND released = 0', deploymentId,
    ).toArray().reduce((sum, item) => sum + BigInt(item.amount_wei), 0n);
    const fundsReady = funds.available.reduce((sum, coin) => sum + coin.opening.amount, 0n) >= activeReserved;
    let gasReady = false;
    if (reason === 'gas-short') {
      const attempts = this.ctx.storage.sql.exec<{ encrypted_raw: string; attempt_no: number; request_id: string }>(
        `SELECT encrypted_raw, attempt_no, request_id FROM reward_attempts WHERE deployment_id = ?
         ORDER BY rowid DESC LIMIT 1`, deploymentId,
      ).toArray();
      const last = attempts[0];
      if (last !== undefined) {
        const raw = await decryptRewardState(secrets.stateKey, deploymentId, last.request_id,
          last.attempt_no, last.encrypted_raw);
        const tx = parseTransaction(raw as `0x${string}`);
        const balance = await runtime.client.getBalance({ address: secrets.owner, blockTag: 'finalized' });
        gasReady = tx.gas !== undefined && tx.maxFeePerGas !== undefined
          && balance >= tx.gas * tx.maxFeePerGas;
      } else {
        const candidate = this.ctx.storage.sql.exec<{ request_id: string }>(
          `SELECT request_id FROM reward_requests WHERE deployment_id = ?
           AND status IN ('processing', 'pending') ORDER BY seq LIMIT 1`, deploymentId,
        ).toArray()[0];
        if (candidate !== undefined) {
          const draft = await loadSavedDraft<LocalDraft>(this.ctx.storage, deploymentId,
            candidate.request_id, secrets.stateKey);
          if (draft?.signature !== undefined) {
            const call = encodePoolSubmission(toPublicSubmission(draft));
            const [gas, fees, balance] = await Promise.all([
              runtime.client.estimateGas({ account: secrets.owner, to: runtime.verified.context.pool,
                data: call.data, value: call.value }),
              runtime.client.estimateFeesPerGas(),
              runtime.client.getBalance({ address: secrets.owner, blockTag: 'finalized' }),
            ]);
            gasReady = fees.maxFeePerGas !== undefined && balance >= call.value + gas * fees.maxFeePerGas;
          }
        }
      }
    }
    let attemptsChecked = true;
    const ids = this.ctx.storage.sql.exec<{ request_id: string }>(
      'SELECT request_id FROM reward_requests WHERE deployment_id = ?', deploymentId,
    ).toArray();
    for (const { request_id } of ids) {
      await listRewardAttempts(this.ctx.storage, deploymentId, request_id, secrets.stateKey);
    }
    const cancellationRaws = this.ctx.storage.sql.exec<{ request_id: string; encrypted_raw: string | null }>(
      'SELECT request_id, encrypted_raw FROM reward_cancellations WHERE deployment_id = ?', deploymentId,
    ).toArray();
    for (const row of cancellationRaws) {
      if (row.encrypted_raw !== null) {
        const raw = await decryptRewardState(secrets.stateKey, deploymentId, row.request_id, 2, row.encrypted_raw);
        if (!/^0x[0-9a-fA-F]+$/.test(raw) || hexToBytes(raw as `0x${string}`).length === 0) {
          attemptsChecked = false;
        }
      }
    }
    resumeRewardAvailability(this.ctx.storage, gate, deploymentId, true, {
      fundsReady, gasReady, keysReadable: true, attemptsChecked,
      recordsComplete: operatorEvidence.recordsComplete,
      chainReconciled: operatorEvidence.chainReconciled,
    });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async stopRewardForDeployment(deploymentId: string, operatorToken: string,
    reason: 'operator-stopped' | 'quota-stopped' | 'restore-stopped'): Promise<void> {
    await this.authorizeRewardOperator(deploymentId, operatorToken);
    if (!['operator-stopped', 'quota-stopped', 'restore-stopped'].includes(reason)) {
      throw new Error('INVALID_REWARD_STOP');
    }
    setRewardAvailability(this.ctx.storage, deploymentId, reason);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body = request.method === 'GET' ? undefined : await readLimitedJson(request);
      const parsed = parseApiRequest(request.method, url.pathname + url.search, body,
        { allowLegacyUnsealedPut: true });
      const config = resolveDeployment(parsed.scope.deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
      const recoveryGate = resolveRecoveryGate(this.env.RECOVERY_JSON, parsed.scope.deploymentId);
      const boundDeployment = await this.ctx.storage.get<string>('deploymentId');
      if (boundDeployment !== undefined && boundDeployment !== parsed.scope.deploymentId) return apiError(403, 'SCOPE_MISMATCH');
      if (boundDeployment === undefined) await this.ctx.storage.put('deploymentId', parsed.scope.deploymentId);
      if (url.origin !== config.origin || (request.method !== 'GET' && request.headers.get('origin') !== config.origin)) {
        return apiError(403, 'SCOPE_MISMATCH');
      }
      if (parsed.route === 'POST /v1/auth/challenge') {
        return apiSuccess(createChallenge(this.ctx.storage, parsed.scope, Date.now()));
      }
      if (parsed.route === 'POST /v1/auth/verify') {
        const result = await verifyChallenge(this.ctx.storage, config, parsed.scope,
          parsed.challengeId!, parsed.siweMessage!, parsed.signature!, Date.now());
        return apiSuccess({ sessionExpiresAt: result.expiresAt }, { 'Set-Cookie': result.cookie });
      }
      const identity = readSessionIdentity(this.ctx.storage, request.headers.get('cookie'), Date.now());
      if (identity === undefined) return apiError(401, 'UNAUTHENTICATED');
      if (identity.deploymentId !== parsed.scope.deploymentId
        || identity.owner.toLowerCase() !== parsed.scope.owner.toLowerCase()) return apiError(403, 'SCOPE_MISMATCH');
      if (parsed.route === 'GET /v1/operations') {
        const page = listOperations(this.ctx.storage, parsed.scope, parsed.cursor);
        return apiSuccess({ availability: getAvailability(this.ctx.storage, recoveryGate), records: page.records.map((item) => ({
          ...asReservation(item), scope: parsed.scope,
          record: { ...item.record, deadline: item.record.kind === 'pay' ? item.record.deadline.toString() : undefined },
        })), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      }
      if (parsed.route === 'GET /v1/operations/{id}') {
        const saved = getOperation(this.ctx.storage, parsed.scope, parsed.id!);
        if (saved === undefined) return apiError(404, 'NOT_FOUND');
        return apiSuccess({
          ...asReservation(saved), scope: parsed.scope,
          record: { ...saved.record, deadline: saved.record.kind === 'pay' ? saved.record.deadline.toString() : undefined },
        });
      }
      if (parsed.route === 'POST /v1/operations/{id}/release') {
        ensureWritable(this.ctx.storage, recoveryGate);
        const current = getOperation(this.ctx.storage, parsed.scope, parsed.id!);
        if (current === undefined) return apiError(404, 'NOT_FOUND');
        if (current.record.kind !== 'pay') return apiError(409, 'RESERVATION_CONFLICT');
        if (current.status === 'released' && current.checkpoint !== undefined) {
          const retry = releaseOperation(this.ctx.storage, parsed.scope, parsed.record!, parsed.expectedRevision!,
            current.checkpoint, () => ensureWritable(this.ctx.storage, recoveryGate));
          return apiSuccess({ ...retry, scope: parsed.scope,
            record: { ...retry.record, deadline: retry.record.kind === 'pay' ? retry.record.deadline.toString() : undefined },
          });
        }
        let runtime;
        try { runtime = await loadEthereumRuntime(parsed.scope.deploymentId, config, this.env.RPC_DEPLOYMENTS_JSON); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        let point;
        try { point = await runtime.history.getFinalizedCheckpoint(); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        if (point === null || point.mode !== config.finalityMode
          || point.hash.toLowerCase() !== parsed.blockHash!.toLowerCase()) {
          return apiError(503, 'SERVICE_UNAVAILABLE');
        }
        let block;
        try { block = await runtime.client.getBlock({ blockTag: config.finalityMode === 'local-simulated' ? 'latest' : 'finalized' }); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        if (block.hash?.toLowerCase() !== point.hash.toLowerCase() || block.number !== point.number
          || block.timestamp <= current.record.deadline) return apiError(503, 'SERVICE_UNAVAILABLE');
        let success;
        try { success = await runtime.history.getOperationSuccess(current.record.operationId, point); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        if (!success.complete || success.blockHash.toLowerCase() !== point.hash.toLowerCase()
          || success.value.executed) return apiError(503, 'SERVICE_UNAVAILABLE');
        const input = await createCoreInputReader(runtime.history, config).readInput(parsed.scope, current.record.inputId);
        if (input !== 'owned-unspent') return apiError(503, 'SERVICE_UNAVAILABLE');
        const released = releaseOperation(this.ctx.storage, parsed.scope, parsed.record!, parsed.expectedRevision!, {
          blockNumber: point.number.toString(), blockHash: point.hash as NonNullable<typeof parsed.blockHash>,
          blockTimestamp: block.timestamp.toString(),
        }, () => ensureWritable(this.ctx.storage, recoveryGate));
        return apiSuccess({ ...released, scope: parsed.scope,
          record: { ...released.record, deadline: released.record.kind === 'pay' ? released.record.deadline.toString() : undefined },
        });
      }
      if (parsed.route === 'PUT /v1/operations/{id}') {
        ensureWritable(this.ctx.storage, recoveryGate);
        const provider = getCoreHistoryProvider();
        let history;
        try { history = provider === undefined
          ? await loadEthereumHistory(parsed.scope.deploymentId, config, this.env.RPC_DEPLOYMENTS_JSON)
          : provider(parsed.scope.deploymentId, config); }
        catch { return apiError(503, 'SERVICE_UNAVAILABLE'); }
        const saved = await putOperation(this.ctx.storage, parsed.scope, parsed.record!, parsed.expectedRevision!,
          createCoreInputReader(history, config), () => ensureWritable(this.ctx.storage, recoveryGate));
        return apiSuccess({ ...asReservation(saved), scope: parsed.scope,
          record: { ...saved.record, deadline: saved.record.kind === 'pay' ? saved.record.deadline.toString() : undefined },
        });
      }
      for (const extension of getServiceExtensions()) {
        const route = extension.routes.find((handler) => handler.route === parsed.route);
        if (route !== undefined) {
          const context = {
            ...makeServiceContext(this.ctx.storage, recoveryGate, parsed.scope,
              { deploymentId: parsed.scope.deploymentId, deployment: config, env: this.env }),
            readRewardFunds: async (deploymentId: string): Promise<bigint | undefined> => {
              if (deploymentId !== parsed.scope.deploymentId) return undefined;
              const secrets = parseRewardSecrets(this.env.REWARD_SECRETS_JSON, deploymentId);
              if (secrets === undefined) return undefined;
              const provider = getCoreHistoryProvider();
              let history;
              try { history = provider === undefined
                ? await loadEthereumHistory(deploymentId, config, this.env.RPC_DEPLOYMENTS_JSON)
                : provider(deploymentId, config); }
              catch { return undefined; }
              const result = await readRewardFunds(history, { getKey: async (owner) => {
                if (owner.toLowerCase() !== secrets.owner.toLowerCase()) throw new Error('REWARD_OWNER_MISMATCH');
                return secrets.receiptKey;
              } }, secrets.owner);
              if (result.status !== 'complete') return undefined;
              const contextPoint = await history.getContext(result.checkpoint);
              if (!contextPoint.complete || contextPoint.value.chainId !== BigInt(config.chainId)
                || contextPoint.value.pool.toLowerCase() !== config.pool.toLowerCase()
                || contextPoint.value.finalityMode !== config.finalityMode) return undefined;
              return result.available.reduce((total, coin) => total + coin.opening.amount, 0n);
            },
            readRewardHistory: async (deploymentId: string) => {
              if (deploymentId !== parsed.scope.deploymentId) throw new Error('SCOPE_MISMATCH');
              const provider = getCoreHistoryProvider();
              return provider === undefined
                ? loadEthereumHistory(deploymentId, config, this.env.RPC_DEPLOYMENTS_JSON)
                : provider(deploymentId, config);
            },
          };
          if (!parsed.route.startsWith('GET ')) context.ensureWritable();
          return await route.handle(parsed, context);
        }
      }
      return apiError(503, 'SERVICE_UNAVAILABLE');
    } catch (error) {
      if (error instanceof BodyTooLarge) return apiError(413, 'PAYLOAD_TOO_LARGE');
      if (error instanceof Error) {
        if (error.message === 'UNKNOWN_DEPLOYMENT') return apiError(503, 'SERVICE_UNAVAILABLE');
        if (error.message === 'CHALLENGE_USED') return apiError(401, 'CHALLENGE_USED');
        if (error.message === 'CHALLENGE_EXPIRED') return apiError(401, 'CHALLENGE_EXPIRED');
        if (error.message === 'UNAUTHENTICATED') return apiError(401, 'UNAUTHENTICATED');
        if (error.name === 'InvalidAddressError' || error.name === 'InvalidSiweMessageError') return apiError(401, 'UNAUTHENTICATED');
        if (error.message === 'SCOPE_MISMATCH') return apiError(403, 'SCOPE_MISMATCH');
        if (error.message === 'RESERVATION_CONFLICT') return apiError(409, 'RESERVATION_CONFLICT');
        if (error.message === 'REVISION_CONFLICT') return apiError(409, 'REVISION_CONFLICT');
        if (error.message === 'NOT_FOUND') return apiError(404, 'NOT_FOUND');
        if (error.message === 'SERVICE_UNAVAILABLE') return apiError(503, 'SERVICE_UNAVAILABLE');
        if (error.message === 'INVALID_RECOVERY_GATE') return apiError(503, 'SERVICE_UNAVAILABLE');
      }
      return apiError(400, 'INVALID_REQUEST');
    }
  }

  async alarm(): Promise<void> {
    const deploymentId = await this.ctx.storage.get<string>('deploymentId');
    if (deploymentId === undefined) throw new Error('UNKNOWN_DEPLOYMENT');
    const gate = resolveRecoveryGate(this.env.RECOVERY_JSON, deploymentId);
    const config = resolveDeployment(deploymentId, parseDeploymentCatalog(this.env.DEPLOYMENTS_JSON));
    const context = makeServiceContext(this.ctx.storage, gate, undefined,
      { deploymentId, deployment: config, env: this.env });
    context.ensureWritable();
    for (const extension of getServiceExtensions()) await extension.alarm?.(context);
  }
}
