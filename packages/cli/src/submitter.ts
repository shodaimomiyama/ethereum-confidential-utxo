import { randomBytes } from "node:crypto";
import { bytesToHex } from "viem";
import type { Hex, PublicClient } from "viem";
import { operationId, preflightSubmission } from "@confidential-utxo/core";
import type { Checkpoint, HistoryPort } from "@confidential-utxo/core";
import { defaultRpcPolicy, observeAttempt, replaceSubmissionFee, submitPublicOperation } from "@confidential-utxo/ethereum";
import type { SendResult, SubmissionWallet, VerifiedDeployment } from "@confidential-utxo/ethereum";
import { EthereumFailure } from "@confidential-utxo/ethereum";
import { appendPrepared, listAttempts, recordSendResult } from "./journal.js";
import type { JournalBinding, PublicIntent } from "./journal.js";
import { decodePublicSubmission, encodePublicSubmission } from "./public-files.js";
import { readLocalSigner } from "./secret-input.js";
import type { CliResult, PublicAttempt } from "./render.js";

type JournalApi = { appendPrepared: typeof appendPrepared;
  recordSendResult: typeof recordSendResult; listAttempts: typeof listAttempts };
const journalDefaults: JournalApi = { appendPrepared, recordSendResult, listAttempts };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new Error("SUBMITTER_INVALID"); }
function publicAttempts(attempts: PublicIntent[]): PublicAttempt[] {
  return attempts.map(item => ({ attemptId: item.attemptId,
    state: item.state === "prepared" ? "unknown" : item.state,
    ...(item.txHash ? { txHash: item.txHash } : {}), nonce: item.nonce,
    gas: item.gas.toString(), maxFeePerGas: item.maxFeePerGas.toString(),
    maxPriorityFeePerGas: item.maxPriorityFeePerGas.toString() }));
}

export class SubmitterService {
  constructor(private readonly wallet: SubmissionWallet, private readonly history: HistoryPort,
    private readonly client: PublicClient, private readonly journal: JournalApi = journalDefaults) {}

  private binding(verified: VerifiedDeployment): JournalBinding {
    const submitter = this.wallet.account?.address;
    if (!submitter) invalid();
    return { chainId: verified.context.chainId, pool: verified.context.pool, submitter };
  }
  private async signer(path: string, binding: JournalBinding): Promise<void> {
    await readLocalSigner(path, binding.submitter);
  }
  private async finalizedSuccess(id: Hex, verified: VerifiedDeployment): Promise<{ checkpoint: Checkpoint; txHash: Hex } | undefined> {
    try {
      const point = await this.history.getFinalizedCheckpoint();
      if (!point || point.mode !== verified.context.finalityMode || point.number < verified.context.deploymentBlock) return undefined;
      const bound = <T>(result: { complete: boolean; blockHash?: Hex; value?: T }): result is { complete: true; blockHash: Hex; value: T } =>
        result.complete && !!result.blockHash && same(result.blockHash, point.hash);
      const [context, record, operations, anchor] = await Promise.all([
        this.history.getContext(point), this.history.getOperationSuccess(id, point),
        this.history.getOperations(verified.context.deploymentBlock, point),
        this.history.getCanonicalHeader(point.number, point),
      ]);
      if (!bound(context) || !bound(record) || !bound(operations) || !bound(anchor) ||
          context.value.chainId !== verified.context.chainId || !same(context.value.pool, verified.context.pool) ||
          context.value.deploymentBlock !== verified.context.deploymentBlock ||
          !same(context.value.verifier, verified.context.verifier) ||
          !same(context.value.parametersHash, verified.context.parametersHash) ||
          context.value.finalityMode !== verified.context.finalityMode ||
          !record.value.executed || anchor.value.number !== point.number || !same(anchor.value.hash, point.hash)) return undefined;
      const matches = operations.value.filter(item => item.success && same(item.success.operationId, id) &&
        same(operationId(verified.context, item.request), id));
      if (matches.length !== 1 || !matches[0]?.success ||
          (record.value.operation && !same(operationId(verified.context, record.value.operation), id))) return undefined;
      const event = matches[0].success;
      if (event.blockNumber < verified.context.deploymentBlock || event.blockNumber > point.number) return undefined;
      const header = await this.history.getCanonicalHeader(event.blockNumber, point);
      if (!bound(header) || header.value.number !== event.blockNumber || !same(header.value.hash, event.blockHash)) return undefined;
      return { checkpoint: point, txHash: event.transactionHash };
    } catch { return undefined; }
  }
  private async send(publicFile: Uint8Array, signerFile: string, journalDir: string,
    verified: VerifiedDeployment): Promise<CliResult> {
    const binding = this.binding(verified);
    const submission = await decodePublicSubmission(publicFile, verified.context);
    await this.signer(signerFile, binding);
    const id = operationId(verified.context, submission.request);
    const attemptId = bytesToHex(randomBytes(32));
    let result: SendResult;
    try {
      result = await submitPublicOperation(verified, this.history, this.wallet, binding.submitter,
        submission, {}, { persistPrepared: intent => this.journal.appendPrepared(journalDir, binding, intent, attemptId) });
    } catch (error) {
      if (error instanceof EthereumFailure && error.code === "STORAGE_UNKNOWN")
        return { kind: "submission", operationId: id, status: "unknown", attemptId };
      throw error;
    }
    try {
      if (await this.journal.recordSendResult(journalDir, binding, attemptId, result) !== "saved")
        return { kind: "submission", operationId: id, status: "unknown", attemptId, ...(result.attempt.txHash ? { txHash: result.attempt.txHash } : {}) };
    } catch { return { kind: "submission", operationId: id, status: "unknown",
      attemptId, ...(result.attempt.txHash ? { txHash: result.attempt.txHash } : {}) }; }
    return { kind: "submission", operationId: id,
      status: result.diagnostic ? "unknown" : "pending", attemptId,
      ...(result.attempt.txHash ? { txHash: result.attempt.txHash } : {}) };
  }

  async submit(publicFile: Uint8Array, signerFile: string, journalDir: string,
    verified: VerifiedDeployment): Promise<CliResult> {
    return this.send(publicFile, signerFile, journalDir, verified);
  }
  async inspect(id: Hex, journalDir: string, verified: VerifiedDeployment): Promise<CliResult> {
    const binding = this.binding(verified);
    const attempts = (await this.journal.listAttempts(journalDir, binding))
      .filter(item => same(item.operationId, id));
    if (attempts.length === 0) invalid();
    const publicRows = publicAttempts(attempts);
    const publicRequest = attempts[0]!.request.request;
    const preflight = await preflightSubmission(verified.context, publicRequest, { history: this.history });
    const observations = await Promise.all(attempts.filter(item => item.txHash).map(item =>
      observeAttempt(this.history, this.client, id, item.txHash!, defaultRpcPolicy)));
    const executed = observations.find(item => item.observation.operation === "executed");
    if (executed) return { kind: "operation", operationId: id, status: "executed",
      ...(executed.observation.txHash ? { txHash: executed.observation.txHash } : {}),
      ...(executed.observation.evidence ? { checkpoint: executed.observation.evidence.checkpoint } : {}),
      attempts: publicRows };
    const logical = await this.finalizedSuccess(id, verified);
    if (logical) return { kind: "operation", operationId: id, status: "executed",
      checkpoint: logical.checkpoint, txHash: logical.txHash, attempts: publicRows };
    if (preflight.status === "conflict") return { kind: "operation", operationId: id, status: "competing", attempts: publicRows };
    if (preflight.status === "executed") return { kind: "operation", operationId: id, status: "unknown", attempts: publicRows };
    if (attempts.some(item => !item.txHash || item.state === "unknown") ||
        observations.some(item => item.observation.outer === "unconfirmed" || item.observation.historyStatus === "reorg"))
      return { kind: "operation", operationId: id, status: "unknown", attempts: publicRows };
    if (observations.some(item => item.observation.outer === "pending"))
      return { kind: "operation", operationId: id, status: "pending", attempts: publicRows };
    if (preflight.status === "ready" && observations.length > 0 &&
        observations.every(item => item.observation.outer === "failed"))
      return { kind: "operation", operationId: id, status: "failed", attempts: publicRows };
    return { kind: "operation", operationId: id, status: "unknown", attempts: publicRows };
  }
  async retry(id: Hex, signerFile: string, journalDir: string,
    verified: VerifiedDeployment): Promise<CliResult> {
    const inspected = await this.inspect(id, journalDir, verified);
    if (inspected.kind !== "operation") invalid();
    if (inspected.status === "executed" || inspected.status === "competing")
      return { kind: "submission", operationId: id, status: inspected.status === "executed" ? "executed" : "competing" };
    if (inspected.status !== "failed") return { kind: "submission", operationId: id, status: "unknown" };
    const binding = this.binding(verified);
    const attempts = (await this.journal.listAttempts(journalDir, binding)).filter(item => same(item.operationId, id));
    const latest = attempts.at(-1);
    if (!latest || !latest.txHash) invalid();
    return this.send(encodePublicSubmission(verified.context, latest.request), signerFile, journalDir, verified);
  }
  async replaceFee(attemptId: Hex, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint,
    signerFile: string, journalDir: string, verified: VerifiedDeployment): Promise<CliResult> {
    const binding = this.binding(verified);
    await this.signer(signerFile, binding);
    const attempts = await this.journal.listAttempts(journalDir, binding);
    const row = attempts.find(item => same(item.attemptId, attemptId));
    if (!row || !row.txHash || row.state !== "pending") invalid();
    const siblings = attempts.filter(item => same(item.operationId, row.operationId));
    if (siblings.at(-1)?.attemptId !== row.attemptId) invalid();
    const inspected = await this.inspect(row.operationId, journalDir, verified);
    if (inspected.kind !== "operation") invalid();
    if (inspected.status === "executed" || inspected.status === "competing")
      return { kind: "submission", operationId: row.operationId, status: inspected.status === "executed" ? "executed" : "competing" };
    if (inspected.status !== "pending") return { kind: "submission", operationId: row.operationId, status: "unknown" };
    const attempt = { outer: "pending" as const, txHash: row.txHash };
    const prior: SendResult = { operationId: row.operationId, account: row.account,
      request: row.request, calldata: row.calldata, value: row.value, nonce: row.nonce, gas: row.gas,
      maxFeePerGas: row.maxFeePerGas, maxPriorityFeePerGas: row.maxPriorityFeePerGas,
      attempt, attempts: [attempt] };
    const newId = bytesToHex(randomBytes(32));
    let result: SendResult;
    try {
      result = await replaceSubmissionFee(verified, this.history, this.wallet, prior,
        { maxFeePerGas, maxPriorityFeePerGas },
        { persistPrepared: intent => this.journal.appendPrepared(journalDir, binding, intent, newId) });
    } catch (error) {
      if (error instanceof EthereumFailure && error.code === "STORAGE_UNKNOWN")
        return { kind: "submission", operationId: row.operationId, status: "unknown", attemptId: newId };
      throw error;
    }
    try {
      if (await this.journal.recordSendResult(journalDir, binding, newId, result) !== "saved")
        return { kind: "submission", operationId: row.operationId, status: "unknown", attemptId: newId };
    } catch { return { kind: "submission", operationId: row.operationId, status: "unknown", attemptId: newId }; }
    return { kind: "submission", operationId: row.operationId,
      status: result.diagnostic ? "unknown" : "pending", attemptId: newId,
      ...(result.attempt.txHash ? { txHash: result.attempt.txHash } : {}) };
  }
}
