import { join } from "node:path";
import { encodePoolSubmission } from "@confidential-utxo/ethereum";
import type { PreparedSend, SendResult } from "@confidential-utxo/ethereum";
import { operationId } from "@confidential-utxo/core";
import type { Context, PublicSubmission } from "@confidential-utxo/core";
import type { Address, Hex } from "viem";
import { createPrivateDirectory, readPrivateFile, replacePrivateFile, withWriterLock } from "./atomic-file.js";
import { decodePublicSubmission, encodePublicSubmission } from "./public-files.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";

const fileName = "journal.json";
const maxBytes = 16 * 1024 * 1024;
const uint256 = (1n << 256n) - 1n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never { throw new Error("INVALID_JOURNAL"); }
export type JournalBinding = { chainId: bigint; pool: Address; submitter: Address };
export type PublicIntent = PreparedSend & { attemptId: Hex; owner: Address;
  txHash?: Hex; state: "prepared" | "pending" | "unknown" | "observed" };
export type JournalV1 = { schemaVersion: 1; chainId: string; pool: Address; submitter: Address;
  intents: Record<Hex, PublicIntent[]> };

function context(binding: JournalBinding): Context {
  return { chainId: binding.chainId, pool: binding.pool, deploymentBlock: 0n,
    verifier: binding.pool, parametersHash: `0x${"00".repeat(32)}`, finalityMode: "local-simulated" };
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(result, key)) ||
      Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return result;
}
function uint(value: unknown): bigint {
  const number = decimalWei(value);
  if (number > uint256) invalid();
  return number;
}
function nonce(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function address(value: unknown): Address { return hexBytes(value, 20) as Address; }
function hash(value: unknown): Hex { return hexBytes(value, 32); }
function assertBinding(binding: JournalBinding): void {
  if (binding.chainId < 1n || binding.chainId > uint256) invalid();
  address(binding.pool); address(binding.submitter);
}
async function validatedPrepared(binding: JournalBinding, intent: PreparedSend): Promise<PreparedSend> {
  assertBinding(binding);
  const id = hash(intent.operationId);
  const account = address(intent.account);
  if (!same(account, binding.submitter)) invalid();
  const requestBytes = encodePublicSubmission(context(binding), intent.request);
  const request = await decodePublicSubmission(requestBytes, context(binding));
  const computedId = operationId(context(binding), request.request);
  if (!same(id, computedId)) invalid();
  const call = encodePoolSubmission(request);
  if (!same(call.data, intent.calldata) || call.value !== intent.value ||
      nonce(intent.nonce) !== intent.nonce || intent.gas <= 0n || intent.gas > uint256 ||
      intent.maxFeePerGas <= 0n || intent.maxFeePerGas > uint256 ||
      intent.maxPriorityFeePerGas <= 0n || intent.maxPriorityFeePerGas > intent.maxFeePerGas) invalid();
  return { operationId: computedId, account, request, calldata: call.data, value: call.value,
    nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas,
    maxPriorityFeePerGas: intent.maxPriorityFeePerGas };
}
function serializedIntent(binding: JournalBinding, intent: PublicIntent): Record<string, unknown> {
  return { attemptId: intent.attemptId, operationId: intent.operationId, owner: intent.owner,
    account: intent.account, submission: JSON.parse(new TextDecoder().decode(encodePublicSubmission(context(binding), intent.request))),
    calldata: intent.calldata, value: intent.value.toString(), nonce: intent.nonce,
    gas: intent.gas.toString(), maxFeePerGas: intent.maxFeePerGas.toString(),
    maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(), state: intent.state,
    ...(intent.txHash ? { txHash: intent.txHash } : {}) };
}
function serialize(binding: JournalBinding, journal: JournalV1): Uint8Array {
  const intents: Record<string, unknown> = {};
  for (const [id, values] of Object.entries(journal.intents)) intents[id] = values.map(value => serializedIntent(binding, value));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, chainId: binding.chainId.toString(),
    pool: binding.pool, submitter: binding.submitter, intents }), "utf8");
  if (bytes.length > maxBytes) invalid();
  return bytes;
}
async function parse(binding: JournalBinding, bytes: Uint8Array): Promise<JournalV1> {
  const root = exact(parseExactObject(bytes, ["schemaVersion", "chainId", "pool", "submitter", "intents"]),
    ["schemaVersion", "chainId", "pool", "submitter", "intents"]);
  if (root.schemaVersion !== 1 || uint(root.chainId) !== binding.chainId ||
      !same(address(root.pool), binding.pool) || !same(address(root.submitter), binding.submitter)) invalid();
  if (root.intents === null || typeof root.intents !== "object" || Array.isArray(root.intents)) invalid();
  const intents: Record<Hex, PublicIntent[]> = {};
  const mapIds = new Set<string>();
  const attemptIds = new Set<string>();
  const reservations = new Map<number, { operationId: Hex; calldata: Hex; value: bigint }>();
  for (const [rawId, items] of Object.entries(root.intents)) {
    const mapId = hash(rawId);
    if (mapIds.has(mapId.toLowerCase())) invalid();
    mapIds.add(mapId.toLowerCase());
    if (!Array.isArray(items) || items.length > 100000) invalid();
    intents[mapId] = [];
    for (const item of items) {
      const row = exact(item, ["attemptId", "operationId", "owner", "account", "submission", "calldata", "value", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "state"], ["txHash"]);
      const attemptId = hash(row.attemptId);
      if (attemptIds.has(attemptId.toLowerCase())) invalid();
      attemptIds.add(attemptId.toLowerCase());
      const publicBytes = Buffer.from(JSON.stringify(row.submission), "utf8");
      const request = await decodePublicSubmission(publicBytes, context(binding));
      const prepared = await validatedPrepared(binding, { operationId: hash(row.operationId), account: address(row.account),
        request, calldata: hexBytes(row.calldata, (String(row.calldata).length - 2) / 2), value: uint(row.value),
        nonce: nonce(row.nonce), gas: uint(row.gas), maxFeePerGas: uint(row.maxFeePerGas),
        maxPriorityFeePerGas: uint(row.maxPriorityFeePerGas) });
      if (!same(mapId, prepared.operationId) || !same(address(row.owner), request.request.owner)) invalid();
      if (!["prepared", "pending", "unknown", "observed"].includes(String(row.state))) invalid();
      const txHash = row.txHash === undefined ? undefined : hash(row.txHash);
      if ((row.state === "pending" || row.state === "observed") && !txHash) invalid();
      const reservation = reservations.get(prepared.nonce);
      if (reservation && (!same(reservation.operationId, prepared.operationId) ||
          !same(reservation.calldata, prepared.calldata) || reservation.value !== prepared.value)) invalid();
      reservations.set(prepared.nonce, { operationId: prepared.operationId,
        calldata: prepared.calldata, value: prepared.value });
      intents[mapId]!.push({ ...prepared, owner: request.request.owner, attemptId,
        state: row.state as PublicIntent["state"], ...(txHash ? { txHash } : {}) });
    }
  }
  return { schemaVersion: 1, chainId: binding.chainId.toString(), pool: binding.pool,
    submitter: binding.submitter, intents };
}
async function read(binding: JournalBinding, dir: string): Promise<JournalV1> {
  const file = join(dir, fileName);
  try { return await parse(binding, await readPrivateFile(file, maxBytes)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: 1, chainId: binding.chainId.toString(), pool: binding.pool,
      submitter: binding.submitter, intents: {} };
  }
}
type Replacer = typeof replacePrivateFile;
async function save(binding: JournalBinding, dir: string, journal: JournalV1,
  replace: Replacer): Promise<"saved" | "unknown"> {
  const bytes = serialize(binding, journal);
  try { await replace(join(dir, fileName), bytes); return "saved"; }
  catch { return "unknown"; }
}

export async function appendPrepared(dir: string, binding: JournalBinding, incoming: PreparedSend,
  attemptId: Hex, replace: Replacer = replacePrivateFile): Promise<"saved" | "unknown"> {
  const prepared = await validatedPrepared(binding, incoming);
  hash(attemptId);
  await createPrivateDirectory(dir);
  return withWriterLock(dir, async () => {
    const journal = await read(binding, dir);
    const all = Object.values(journal.intents).flat();
    if (all.some(item => same(item.attemptId, attemptId))) invalid();
    if (all.some(item => item.nonce === prepared.nonce &&
        (!same(item.operationId, prepared.operationId) || !same(item.calldata, prepared.calldata) || item.value !== prepared.value))) invalid();
    const row: PublicIntent = { ...prepared, attemptId, owner: prepared.request.request.owner, state: "prepared" };
    journal.intents[prepared.operationId] = [...(journal.intents[prepared.operationId] ?? []), row];
    return save(binding, dir, journal, replace);
  });
}

export async function recordSendResult(dir: string, binding: JournalBinding, attemptId: Hex,
  result: SendResult, replace: Replacer = replacePrivateFile): Promise<"saved" | "unknown"> {
  hash(attemptId);
  return withWriterLock(dir, async () => {
    const journal = await read(binding, dir);
    const row = Object.values(journal.intents).flat().find(item => same(item.attemptId, attemptId));
    if (!row) invalid();
    const matched = await validatedPrepared(binding, result);
    if (!same(matched.operationId, row.operationId) || matched.nonce !== row.nonce ||
        matched.gas !== row.gas || matched.maxFeePerGas !== row.maxFeePerGas ||
        matched.maxPriorityFeePerGas !== row.maxPriorityFeePerGas ||
        !same(matched.calldata, row.calldata) || matched.value !== row.value) invalid();
    row.state = result.attempt.outer === "unconfirmed" ? "unknown" :
      result.attempt.outer === "pending" ? "pending" : "observed";
    if (result.attempt.txHash) row.txHash = result.attempt.txHash;
    return save(binding, dir, journal, replace);
  });
}

export async function listAttempts(dir: string, binding: JournalBinding): Promise<PublicIntent[]> {
  assertBinding(binding);
  const journal = await read(binding, dir);
  return Object.values(journal.intents).flat().map(item => ({ ...structuredClone(item),
    state: item.state === "prepared" ? "unknown" as const : item.state }));
}
