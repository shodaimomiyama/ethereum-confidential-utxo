import { commit } from "@confidential-utxo/crypto";
import type { Opening } from "@confidential-utxo/crypto";
import type { Hex } from "viem";
import { verifyOperationAuthorization } from "./authorization.js";
import { operationId, outputId, validateOperationShape } from "./encoding.js";
import { toPublicSubmission } from "./operation.js";
import type { PublicSubmission } from "./operation.js";
import { synchronize } from "./sync.js";
import type { AttemptObservation, Checkpoint, Context, HistoryPort, LocalDraft, Observation, OperationRequest, OperationSuccessEvidence, OperationTracking, ReceiptKeyPort, StoragePort, SubmissionAttempt } from "./types.js";

export type LatestState = { number: bigint; hash: Hex };
export type PreflightResult =
  | { status: "ready"; latest: LatestState }
  | { status: "executed" | "conflict"; latest: LatestState }
  | { status: "unconfirmed"; latest?: LatestState };
export type SubmissionPorts = { history: HistoryPort; storage: StoragePort; keys: ReceiptKeyPort };
export type PreparedSubmission = { status: "ready"; latest: LatestState; submission: PublicSubmission } |
  { status: "executed" | "conflict"; latest: LatestState } |
  { status: "unconfirmed"; latest?: LatestState } |
  { status: "storage-unknown" | "invalid" };
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function value<T>(observation: Observation<T>, point: Checkpoint): T {
  if (!observation.complete || !equal(observation.blockHash, point.hash)) throw new Error();
  return structuredClone(observation.value);
}
function sameContext(a: Context, b: Context): boolean {
  return a.chainId === b.chainId && equal(a.pool, b.pool) && a.deploymentBlock === b.deploymentBlock &&
    equal(a.verifier, b.verifier) && equal(a.parametersHash, b.parametersHash) && a.finalityMode === b.finalityMode;
}
function verifiedSuccess(id: Hex, evidence: OperationSuccessEvidence): boolean {
  try {
    const { context, checkpoint: point, event: observed } = evidence;
    const event = observed.success;
    const record = value(evidence.record, point);
    const header = value(evidence.header, point);
    validateOperationShape(observed.request);
    return !!event && point.mode === context.finalityMode && record.executed &&
      equal(operationId(context, observed.request), id) && equal(event.operationId, id) &&
      (!record.operation || equal(operationId(context, record.operation), id)) &&
      event.blockNumber >= context.deploymentBlock && event.blockNumber <= point.number &&
      header.number === event.blockNumber && equal(header.hash, event.blockHash) &&
      (header.number !== point.number || equal(header.hash, point.hash)) &&
      Number.isSafeInteger(event.transactionIndex) && event.transactionIndex >= 0 &&
      Number.isSafeInteger(event.logIndex) && event.logIndex >= 0;
  } catch { return false; }
}
function publicAttempt(attempt: SubmissionAttempt): SubmissionAttempt {
  return { outer: attempt.outer,
    ...(attempt.txHash === undefined ? {} : { txHash: attempt.txHash }),
    ...(attempt.blockNumber === undefined ? {} : { blockNumber: attempt.blockNumber }),
    ...(attempt.blockHash === undefined ? {} : { blockHash: attempt.blockHash }),
    ...(attempt.failure === undefined ? {} : { failure: attempt.failure }) };
}
/** Preserves adopted success independently of outer attempts until history invalidation.
 * Evidence observations rely on the HistoryPort completeness/canonical-ancestry contract.
 * The checkpoint carries finality mode; an outer receipt supplies no such assertion.
 */
export function trackAttempt(id: Hex, observation: AttemptObservation, prior: SubmissionAttempt[] | OperationTracking): OperationTracking {
  const previous = Array.isArray(prior) ? undefined : prior;
  const attempts = (Array.isArray(prior) ? prior : prior.attempts).map(publicAttempt);
  const attempt = publicAttempt(observation);
  const index = attempt.txHash === undefined ? -1 : attempts.findIndex(a => a.txHash !== undefined && equal(a.txHash, attempt.txHash!));
  if (index < 0) attempts.push(attempt);
  else attempts[index] = attempt;
  const evidence = observation.historyStatus ? undefined : observation.evidence ??
    (previous && equal(previous.operationId, id) ? previous.successEvidence : undefined);
  const confirmed = evidence && verifiedSuccess(id, evidence);
  return { operationId: id, attempts, operation: confirmed ? "executed" : "unconfirmed", receipt: "unconfirmed",
    ...(confirmed ? { checkpoint: structuredClone(evidence!.checkpoint), successEvidence: structuredClone(evidence!) } : {}) };
}

async function preflight(context: Context, request: OperationRequest, history: HistoryPort, openings?: Opening[], anchor?: Checkpoint): Promise<PreflightResult> {
  let latestState: LatestState | undefined;
  const unconfirmed = (): PreflightResult => ({ status: "unconfirmed", ...(latestState ? { latest: latestState } : {}) });
  try {
    const ctx = structuredClone(context);
    const req = structuredClone(request);
    validateOperationShape(req);
    const id = operationId(ctx, req);
    const latest = await history.getLatestHeader();
    if (!latest || latest.number < ctx.deploymentBlock) return unconfirmed();
    latestState = { number: latest.number, hash: latest.hash };
    const point: Checkpoint = Object.freeze({ ...structuredClone(latest), mode: ctx.finalityMode });
    if (anchor) {
      if (anchor.number > point.number) return unconfirmed();
      const canonical = value(await history.getCanonicalHeader(anchor.number, point), point);
      if (canonical.number !== anchor.number || !equal(canonical.hash, anchor.hash)) return unconfirmed();
    }
    if (!sameContext(ctx, value(await history.getContext(point), point))) return unconfirmed();
    const record = await history.getLatestOperationSuccess(id, point);
    const success = value(record, point);
    const operations = value(await history.getOperations(ctx.deploymentBlock, point), point);
    const matches = operations.filter(o => equal(operationId(ctx, o.request), id) || (o.success && equal(o.success.operationId, id)));
    let result: "ready" | "executed" | "conflict" = "ready";
    if (success.executed) {
      if (matches.length !== 1) return unconfirmed();
      const event = matches[0]!;
      if (!event.success || !verifiedSuccess(id, { context: ctx, checkpoint: point, event, record,
        header: await history.getCanonicalHeader(event.success.blockNumber, point) })) return unconfirmed();
      result = "executed";
    } else {
      if (matches.length !== 0 || success.operation) return unconfirmed();
      for (let i = 0; i < req.inputIds.length; i++) {
        const state = value(await history.getLatestUtxo(req.inputIds[i]!, point), point);
        if (!state.exists) return unconfirmed();
        if (state.consumedBy) {
          if (equal(state.consumedBy, id)) return unconfirmed();
          result = "conflict";
          continue;
        }
        if (!state.owner || !equal(state.owner, req.owner) || !state.commitment) return unconfirmed();
        if (openings) {
          const c = commit(openings[i]!);
          if (c.x !== state.commitment.x || c.y !== state.commitment.y) return unconfirmed();
        }
      }
    }
    const end = value(await history.getCanonicalHeader(point.number, point), point);
    if (end.number !== point.number || !equal(end.hash, point.hash)) return unconfirmed();
    return { status: result, latest: latestState };
  } catch { return unconfirmed(); }
}
/** Ready permits an explicit attempt at this pinned state; it never proves non-submission.
 * Latest-state execution prevents resubmission but is not a finalized-success assertion.
 */
export async function preflightSubmission(context: Context, request: OperationRequest, ports: { history: HistoryPort }): Promise<PreflightResult> {
  return preflight(context, request, ports.history);
}
function freezeTree(value: object): void {
  Object.values(value).forEach(child => { if (child !== null && typeof child === "object") freezeTree(child); });
  Object.freeze(value);
}
function validateDraft(draft: LocalDraft): void {
  validateOperationShape(draft.request);
  if (!equal(operationId(draft.context, draft.request), draft.operationId) || !draft.signature ||
    draft.openings.length !== draft.request.outputs.length || draft.inputOpenings.length !== draft.request.inputIds.length ||
    draft.outputIds.length !== draft.request.outputs.length || draft.outputIds.some((id, i) => !equal(id, outputId(draft.operationId, i)))) throw new Error();
  const outputs = draft.openings.map(commit);
  draft.inputOpenings.forEach(commit);
  if (outputs.some((c, i) => c.x !== draft.request.outputs[i]!.commitment.x || c.y !== draft.request.outputs[i]!.commitment.y) ||
    draft.inputOpenings.reduce((sum, o) => sum + o.amount, draft.request.d) !== draft.openings.reduce((sum, o) => sum + o.amount, draft.request.w)) throw new Error();
}
/** Explicit preparation only: resynchronize restored state, persist, then recheck latest state.
 * No submission is performed. Every invocation repeats these checks, including deposits.
 */
export async function prepareSubmission(signedDraft: LocalDraft, ports: SubmissionPorts): Promise<PreparedSubmission> {
  let draft: LocalDraft;
  let submission: PublicSubmission;
  try {
    draft = structuredClone(signedDraft);
    validateDraft(draft);
    await verifyOperationAuthorization(draft.context, draft.operationId, draft.request.owner, draft.signature!);
    submission = toPublicSubmission(draft);
  } catch { return { status: "invalid" }; }
  const synced = await synchronize(draft.context, { history: ports.history, keys: ports.keys, owners: [draft.request.owner] });
  if (synced.status !== "complete") return { status: "unconfirmed" };
  for (let i = 0; i < draft.request.inputIds.length; i++) {
    const input = synced.utxos.find(u => equal(u.id, draft.request.inputIds[i]!));
    const opening = draft.inputOpenings[i]!;
    if (!input || !equal(input.owner, draft.request.owner) || input.opening.amount !== opening.amount || input.opening.blinding !== opening.blinding) return { status: "unconfirmed" };
    // Spent inputs still reach preflight so executed/conflicting operations are distinguished.
  }
  try {
    const saved = structuredClone(draft);
    freezeTree(saved);
    if (await ports.storage.saveDraft(saved) !== "saved") return { status: "storage-unknown" };
  } catch { return { status: "storage-unknown" }; }
  const result = await preflight(draft.context, draft.request, ports.history, draft.inputOpenings, synced.checkpoint);
  if (result.status === "ready" && draft.request.inputIds.some(id => synced.utxos.find(u => equal(u.id, id))?.status !== "available")) return { status: "unconfirmed", latest: result.latest };
  return result.status === "ready" ? { ...result, submission } : result;
}
