import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { operationId, preflightSubmission, validateOperationShape, verifyOperationAuthorization } from "@confidential-utxo/core";
import type { HistoryPort, PublicSubmission, SubmissionAttempt } from "@confidential-utxo/core";
import { poolAbi } from "./abi.js";
import type { VerifiedDeployment } from "./deployment.js";
import { EthereumFailure } from "./errors.js";

export type SendOptions = { gas?: bigint; nonce?: number; maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint; signal?: AbortSignal };
export type SubmissionWallet = {
  account?: LocalAccount | { address: Address; type: "json-rpc" };
  chain?: { id: number };
  getChainId(): Promise<number>;
  estimateGas(args: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  sendTransaction(args: { account: Address | LocalAccount; to: Address; data: Hex; value: bigint; gas: bigint;
    nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex>;
};
export type SendResult = { operationId: Hex; attempt: SubmissionAttempt; attempts: SubmissionAttempt[];
  nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  request: PublicSubmission; calldata: Hex; value: bigint; account: Address;
  diagnostic?: "SUBMISSION_UNKNOWN" };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const positive = (value: bigint) => value > 0n && value < (1n << 256n);
function invalid(stage: string): never { throw new EthereumFailure("INVALID_CONFIG", stage); }
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new EthereumFailure("ABORTED", "submission.abort");
}

export function encodePoolSubmission(submission: PublicSubmission): { data: Hex; value: bigint } {
  validateOperationShape(submission.request);
  const { request, balanceProof, rangeProofs, signature } = submission;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) invalid("submission.signature");
  if (request.kind === 0 && rangeProofs.length !== 0) invalid("submission.proofs");
  if (request.kind !== 0 && rangeProofs.length !== request.outputs.length) invalid("submission.proofs");
  const tuple = { kind: request.kind, owner: request.owner, salt: request.salt,
    inputIds: request.inputIds, outputs: request.outputs.map(item => ({ owner: item.owner,
      Cx: item.commitment.x, Cy: item.commitment.y, receiptFormat: item.receiptFormat,
      packet: item.packet })), d: request.d, w: request.w, destination: request.destination };
  const functionName = request.kind === 0 ? "deposit" : request.kind === 1 ? "transfer" : "withdraw";
  const args = request.kind === 0 ? [tuple, balanceProof, signature] :
    [tuple, balanceProof, rangeProofs, signature];
  const data = encodeFunctionData({ abi: poolAbi, functionName, args: args as never });
  return { data, value: request.kind === 0 ? request.d : 0n };
}

async function ready(verified: VerifiedDeployment, history: HistoryPort, submission: PublicSubmission): Promise<Hex> {
  const id = operationId(verified.context, submission.request);
  try { await verifyOperationAuthorization(verified.context, id, submission.request.owner, submission.signature); }
  catch { throw new EthereumFailure("SIGNATURE_INVALID", "submission.authorization"); }
  const result = await preflightSubmission(verified.context, submission.request, { history });
  if (result.status !== "ready") throw new EthereumFailure(result.status === "unconfirmed" ? "GAP" :
    "SIMULATION_FAILED", `submission.preflight.${result.status}`);
  return id;
}

function checkOptions(options: SendOptions) {
  if ((options.gas !== undefined && !positive(options.gas)) ||
      (options.nonce !== undefined && (!Number.isSafeInteger(options.nonce) || options.nonce < 0)) ||
      (options.maxFeePerGas !== undefined && !positive(options.maxFeePerGas)) ||
      (options.maxPriorityFeePerGas !== undefined && !positive(options.maxPriorityFeePerGas)) ||
      (options.maxFeePerGas !== undefined && options.maxPriorityFeePerGas !== undefined &&
        options.maxFeePerGas < options.maxPriorityFeePerGas)) invalid("submission.options");
}

async function checkWallet(verified: VerifiedDeployment, wallet: SubmissionWallet, account: Address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account) ||
      (wallet.account && !same(wallet.account.address, account)) ||
      (wallet.chain && BigInt(wallet.chain.id) !== verified.context.chainId)) invalid("submission.account");
  let chainId: number;
  try { chainId = await wallet.getChainId(); }
  catch { throw new EthereumFailure("RPC", "submission.chain"); }
  if (BigInt(chainId) !== verified.context.chainId) throw new EthereumFailure("DEPLOYMENT_MISMATCH", "submission.chain");
}

async function quote(wallet: SubmissionWallet, account: Address, to: Address, data: Hex, value: bigint,
  options: SendOptions) {
  try {
    const gas = options.gas ?? await wallet.estimateGas({ account, to, data, value });
    const fees = options.maxFeePerGas !== undefined && options.maxPriorityFeePerGas !== undefined ?
      { maxFeePerGas: options.maxFeePerGas, maxPriorityFeePerGas: options.maxPriorityFeePerGas } :
      await wallet.estimateFeesPerGas();
    const maxFeePerGas = options.maxFeePerGas ?? fees.maxFeePerGas;
    const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas;
    const nonce = options.nonce ?? await wallet.getTransactionCount({ address: account, blockTag: "pending" });
    if (!positive(gas) || maxFeePerGas === undefined || maxPriorityFeePerGas === undefined ||
        !positive(maxFeePerGas) || !positive(maxPriorityFeePerGas) ||
        maxFeePerGas < maxPriorityFeePerGas || !Number.isSafeInteger(nonce) || nonce < 0) invalid("submission.quote");
    const balance = await wallet.getBalance({ address: account });
    if (balance < value + gas * maxFeePerGas) throw new EthereumFailure("SIMULATION_FAILED", "submission.balance");
    return { gas, nonce, maxFeePerGas, maxPriorityFeePerGas };
  } catch (error) {
    if (error instanceof EthereumFailure) throw error;
    throw new EthereumFailure("SIMULATION_FAILED", "submission.quote");
  }
}

async function send(verified: VerifiedDeployment, wallet: SubmissionWallet, account: Address,
  submission: PublicSubmission, id: Hex, calldata: Hex, value: bigint,
  selected: { gas: bigint; nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  prior: SubmissionAttempt[] = []): Promise<SendResult> {
  let attempt: SubmissionAttempt;
  try {
    const signingAccount = wallet.account?.type === "local" ? wallet.account : account;
    const txHash = await wallet.sendTransaction({ account: signingAccount, to: verified.context.pool, data: calldata,
      value, ...selected });
    attempt = { outer: "pending", txHash };
  } catch {
    // The RPC may have accepted the transaction before its response was lost.
    attempt = { outer: "unconfirmed" };
  }
  return { operationId: id, attempt, attempts: [...prior, attempt], request: structuredClone(submission),
    calldata, value, account, ...selected,
    ...(attempt.outer === "unconfirmed" ? { diagnostic: "SUBMISSION_UNKNOWN" as const } : {}) };
}

export async function submitPublicOperation(verified: VerifiedDeployment, history: HistoryPort,
  wallet: SubmissionWallet, account: Address, submission: PublicSubmission,
  options: SendOptions = {}): Promise<SendResult> {
  checkOptions(options);
  checkAbort(options.signal);
  const { data, value } = encodePoolSubmission(submission);
  await checkWallet(verified, wallet, account);
  const id = await ready(verified, history, submission);
  checkAbort(options.signal);
  const selected = await quote(wallet, account, verified.context.pool, data, value, options);
  checkAbort(options.signal);
  return send(verified, wallet, account, submission, id, data, value, selected);
}

export async function replaceSubmissionFee(verified: VerifiedDeployment, history: HistoryPort,
  wallet: SubmissionWallet, prior: SendResult,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; signal?: AbortSignal }): Promise<SendResult> {
  checkOptions(fees);
  checkAbort(fees.signal);
  if (!Number.isSafeInteger(prior.nonce) || prior.nonce < 0 || !positive(prior.gas) ||
      !positive(prior.maxFeePerGas) || !positive(prior.maxPriorityFeePerGas) ||
      prior.attempts.length < 1 || prior.attempts.at(-1)?.outer !== prior.attempt.outer ||
      !same(prior.operationId, operationId(verified.context, prior.request.request))) invalid("replacement.prior");
  const call = encodePoolSubmission(prior.request);
  if (!same(call.data, prior.calldata) || call.value !== prior.value) invalid("replacement.calldata");
  const bump = (old: bigint) => old + (old + 9n) / 10n;
  if (fees.maxFeePerGas < bump(prior.maxFeePerGas) ||
      fees.maxPriorityFeePerGas < bump(prior.maxPriorityFeePerGas)) invalid("replacement.fees");
  await checkWallet(verified, wallet, prior.account);
  const id = await ready(verified, history, prior.request);
  checkAbort(fees.signal);
  const selected = await quote(wallet, prior.account, verified.context.pool, call.data, call.value,
    { gas: prior.gas, nonce: prior.nonce, ...fees });
  checkAbort(fees.signal);
  return send(verified, wallet, prior.account, prior.request, id, call.data, call.value,
    selected, prior.attempts);
}
