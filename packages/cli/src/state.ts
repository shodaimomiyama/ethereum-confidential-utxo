import { createPrivateKey, createPublicKey } from "node:crypto";
import { commit, M, P, Q } from "@confidential-utxo/crypto";
import type { BalanceProof, G1Point, Opening, RangeProof } from "@confidential-utxo/crypto";
import { operationId, outputId, receiptInfo, validateOperationShape } from "@confidential-utxo/core";
import type { Checkpoint, Context, LocalDraft, OperationRequest, OwnedUtxo, SyncResult } from "@confidential-utxo/core";
import { hexToBytes } from "viem";
import type { Address, Hex } from "viem";
import type { PaymentTerms } from "@confidential-utxo/uniswap";
import type { PayQuote } from "@confidential-utxo/uniswap";
import { createPrivateDirectory, readPrivateFile, replacePrivateFile, withWriterLock } from "./atomic-file.js";
import { openEnvelope, sealEnvelope } from "./envelope.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";
import { join } from "node:path";

const fileName = "state.enc";
const maxFileBytes = 16 * 1024 * 1024;
const uint256 = (1n << 256n) - 1n;
const privateKeyPrefix = Buffer.from("302e020100300506032b656e04220420", "hex");
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function invalid(): never { throw new Error("INVALID_OWNER_STATE"); }

export type FixedOperationV1 = Pick<LocalDraft, "context" | "request" | "operationId" | "outputIds" | "openings" | "inputOpenings">;
export type StoredOperationV1 =
  | { phase: "fixed"; fixed: FixedOperationV1 }
  | { phase: "proved"; fixed: FixedOperationV1; balanceProof: BalanceProof; rangeProofs: RangeProof[] }
  | { phase: "authorized"; fixed: FixedOperationV1; balanceProof: BalanceProof; rangeProofs: RangeProof[]; signature: Hex };
export type ReceiptKeyV1 = { id: Hex; secretKey: Hex; publicKey: Hex };
export type RewardProgressV1 = { amountWei: bigint; recipientInfo: {
  chainId: bigint; pool: Address; owner: Address; receivePublicKey: Hex;
  receiptFormat: 1; recipientInfoVersion: 1; signature: Hex };
  status: "prepared" | "requested" | "distributed" | "received" | "unknown";
  operationId?: Hex; outputId?: Hex; blockHash?: Hex };
export type PaymentEntryV1 = { operationId: Hex; paymentId: Hex; terms: PaymentTerms;
  privateDraft: StoredOperationV1; poolSignature?: Hex; paymentSignature?: Hex;
  autoMinAmountOut?: boolean; autoDeadline?: boolean;
  quote?: PayQuote;
  attemptIds: Hex[]; txHashes: Hex[]; lastCheckpoint?: { number: bigint; hash: Hex } };
export type PaymentProgressV1 = { revision: number; deploymentId: string; recordKey: Hex;
  rewards: Record<Hex, RewardProgressV1>; payments: Record<Hex, PaymentEntryV1> };
export type WalletStateV1 = {
  schemaVersion: 1;
  context: Context;
  owner: Address;
  receiptKeys: ReceiptKeyV1[];
  activeReceiptKeyId: Hex | null;
  operations: Record<Hex, StoredOperationV1>;
  sync: SyncResult | null;
  restoration: "ready" | "needs-resync";
  backupCreatedAt?: string;
  connection?: PaymentProgressV1;
};

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (required.some(key => !Object.hasOwn(record, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}
function array(value: unknown, max = 100000): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function uint(value: unknown, max: bigint = uint256): bigint {
  const number = decimalWei(value);
  if (number > max) invalid();
  return number;
}
function address(value: unknown): Address { return hexBytes(value, 20) as Address; }
function hash(value: unknown): Hex { return hexBytes(value, 32); }
function point(value: unknown): G1Point {
  const input = object(value, ["x", "y"]);
  return { x: uint(input.x, P - 1n), y: uint(input.y, P - 1n) };
}
function opening(value: unknown): Opening {
  const input = object(value, ["amount", "blinding"]);
  const amount = uint(input.amount, M);
  const blinding = uint(input.blinding, Q - 1n);
  if (amount === 0n) invalid();
  return { amount, blinding };
}
function context(value: unknown): Context {
  const input = object(value, ["chainId", "pool", "deploymentBlock", "verifier", "parametersHash", "finalityMode"]);
  if (input.finalityMode !== "finalized" && input.finalityMode !== "local-simulated") invalid();
  const chainId = uint(input.chainId);
  if (chainId === 0n) invalid();
  return { chainId, pool: address(input.pool), deploymentBlock: uint(input.deploymentBlock),
    verifier: address(input.verifier), parametersHash: hash(input.parametersHash), finalityMode: input.finalityMode };
}
function sameContext(a: Context, b: Context): boolean {
  return a.chainId === b.chainId && same(a.pool, b.pool) && a.deploymentBlock === b.deploymentBlock &&
    same(a.verifier, b.verifier) && same(a.parametersHash, b.parametersHash) && a.finalityMode === b.finalityMode;
}
function request(value: unknown): OperationRequest {
  const input = object(value, ["kind", "owner", "salt", "inputIds", "outputs", "d", "w", "destination"]);
  if (input.kind !== 0 && input.kind !== 1 && input.kind !== 2) invalid();
  const parsed: OperationRequest = { kind: input.kind, owner: address(input.owner), salt: hash(input.salt),
    inputIds: array(input.inputIds, 2).map(hash),
    outputs: array(input.outputs, 2).map(value => {
      const output = object(value, ["owner", "commitment", "receiptFormat", "packet"]);
      if (output.receiptFormat !== 1) invalid();
      return { owner: address(output.owner), commitment: point(output.commitment),
        receiptFormat: 1 as const, packet: hexBytes(output.packet, 112) };
    }), d: uint(input.d, M), w: uint(input.w, 2n * M), destination: address(input.destination) };
  validateOperationShape(parsed);
  return parsed;
}
function fixed(value: unknown, expected: Context, owner: Address): FixedOperationV1 {
  const input = object(value, ["context", "request", "operationId", "outputIds", "openings", "inputOpenings"]);
  const ctx = context(input.context);
  if (!sameContext(ctx, expected)) invalid();
  const req = request(input.request);
  if (!same(req.owner, owner)) invalid();
  const id = hash(input.operationId);
  if (!same(id, operationId(ctx, req))) invalid();
  const outputIds = array(input.outputIds, 2).map(hash);
  const openings = array(input.openings, 2).map(opening);
  const inputOpenings = array(input.inputOpenings, 2).map(opening);
  if (outputIds.length !== req.outputs.length || openings.length !== req.outputs.length ||
      inputOpenings.length !== req.inputIds.length) invalid();
  outputIds.forEach((value, index) => { if (!same(value, outputId(id, index))) invalid(); });
  openings.forEach((value, index) => {
    const expectedPoint = commit(value);
    const stored = req.outputs[index]!.commitment;
    if (expectedPoint.x !== stored.x || expectedPoint.y !== stored.y) invalid();
    receiptInfo(ctx, req, index);
  });
  const inTotal = inputOpenings.reduce((sum, value) => sum + value.amount, req.d);
  const outTotal = openings.reduce((sum, value) => sum + value.amount, req.w);
  if (inTotal !== outTotal) invalid();
  return { context: ctx, request: req, operationId: id, outputIds, openings, inputOpenings };
}
function balanceProof(value: unknown): BalanceProof {
  const input = object(value, ["Rx", "Ry", "s"]);
  return { Rx: uint(input.Rx, P - 1n), Ry: uint(input.Ry, P - 1n), s: uint(input.s, Q - 1n) };
}
function rangeProof(value: unknown): RangeProof {
  const input = object(value, ["coords", "scalars", "ls", "rs"]);
  const numbers = (value: unknown, max: bigint) => array(value, 64).map(item => uint(item, max));
  const coords = numbers(input.coords, P - 1n);
  const scalars = numbers(input.scalars, Q - 1n);
  const ls = numbers(input.ls, P - 1n);
  const rs = numbers(input.rs, P - 1n);
  if (coords.length !== 10 || scalars.length !== 5 || ls.length !== 12 || rs.length !== 12) invalid();
  return { coords, scalars, ls, rs };
}
function operation(value: unknown, expected: Context, owner: Address): StoredOperationV1 {
  const base = object(value, ["phase", "fixed"], ["balanceProof", "rangeProofs", "signature"]);
  const parsedFixed = fixed(base.fixed, expected, owner);
  if (base.phase === "fixed") {
    object(value, ["phase", "fixed"]);
    return { phase: "fixed", fixed: parsedFixed };
  }
  if (base.phase !== "proved" && base.phase !== "authorized") invalid();
  const input = object(value, base.phase === "proved" ? ["phase", "fixed", "balanceProof", "rangeProofs"] :
    ["phase", "fixed", "balanceProof", "rangeProofs", "signature"]);
  const proof = balanceProof(input.balanceProof);
  const ranges = array(input.rangeProofs, 2).map(rangeProof);
  if (ranges.length !== (parsedFixed.request.kind === 0 ? 0 : parsedFixed.request.outputs.length)) invalid();
  if (base.phase === "proved") return { phase: "proved", fixed: parsedFixed, balanceProof: proof, rangeProofs: ranges };
  return { phase: "authorized", fixed: parsedFixed, balanceProof: proof, rangeProofs: ranges,
    signature: hexBytes(input.signature, 65) };
}
function paymentTerms(value: unknown): PaymentTerms {
  const row = object(value, ["operationId", "owner", "ethAmount", "token", "minAmountOut", "recipient", "deadline"]);
  const deadline = uint(row.deadline, (1n << 64n) - 1n);
  const ethAmount = uint(row.ethAmount);
  const minAmountOut = uint(row.minAmountOut);
  if (deadline === 0n || ethAmount === 0n || minAmountOut === 0n) invalid();
  return { operationId: hash(row.operationId) as PaymentTerms["operationId"],
    owner: address(row.owner) as PaymentTerms["owner"], ethAmount,
    token: address(row.token) as PaymentTerms["token"], minAmountOut,
    recipient: address(row.recipient) as PaymentTerms["recipient"], deadline };
}
function connection(value: unknown, expected: Context, owner: Address): PaymentProgressV1 {
  const row = object(value, ["revision", "deploymentId", "recordKey", "rewards", "payments"]);
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1 ||
    typeof row.deploymentId !== "string" || !row.deploymentId || row.deploymentId.length > 256) invalid();
  const entries = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const map = Object.entries(value);
    if (map.length > 100000 || new Set(map.map(([id]) => hash(id).toLowerCase())).size !== map.length) invalid();
    return map;
  };
  const rewards: Record<Hex, RewardProgressV1> = {};
  for (const [id, value] of entries(row.rewards)) {
    const reward = object(value, ["amountWei", "recipientInfo", "status"], ["operationId", "outputId", "blockHash"]);
    if (!["prepared", "requested", "distributed", "received", "unknown"].includes(String(reward.status))) invalid();
    const info = object(reward.recipientInfo, ["chainId", "pool", "owner", "receivePublicKey",
      "receiptFormat", "recipientInfoVersion", "signature"]);
    if (uint(info.chainId) !== expected.chainId || !same(address(info.pool), expected.pool) ||
      !same(address(info.owner), owner) || info.receiptFormat !== 1 || info.recipientInfoVersion !== 1) invalid();
    rewards[hash(id)] = { amountWei: uint(reward.amountWei), recipientInfo: {
      chainId: expected.chainId, pool: expected.pool, owner, receivePublicKey: hash(info.receivePublicKey),
      receiptFormat: 1, recipientInfoVersion: 1, signature: hexBytes(info.signature, 65) },
    status: reward.status as RewardProgressV1["status"],
    ...(reward.operationId === undefined ? {} : { operationId: hash(reward.operationId) }),
    ...(reward.outputId === undefined ? {} : { outputId: hash(reward.outputId) }),
    ...(reward.blockHash === undefined ? {} : { blockHash: hash(reward.blockHash) }) };
  }
  const payments: Record<Hex, PaymentEntryV1> = {};
  for (const [id, value] of entries(row.payments)) {
    const pay = object(value, ["operationId", "paymentId", "terms", "privateDraft", "attemptIds", "txHashes"],
      ["poolSignature", "paymentSignature", "lastCheckpoint", "autoMinAmountOut", "autoDeadline", "quote"]);
    const terms = paymentTerms(pay.terms);
    const operationId = hash(pay.operationId);
    if (!same(terms.operationId, operationId) || !same(terms.owner, owner)) invalid();
    const privateDraft = operation(pay.privateDraft, expected, owner);
    if (!same(privateDraft.fixed.operationId, operationId) ||
      privateDraft.fixed.request.kind !== 2) invalid();
    const lastCheckpoint = pay.lastCheckpoint === undefined ? undefined : object(pay.lastCheckpoint, ["number", "hash"]);
    if (pay.autoMinAmountOut !== undefined && typeof pay.autoMinAmountOut !== "boolean" ||
      pay.autoDeadline !== undefined && typeof pay.autoDeadline !== "boolean") invalid();
    let quote: PayQuote | undefined;
    if (pay.quote !== undefined) {
      const item = object(pay.quote, ["startedAtMs", "blockHash", "blockNumber", "inputWei", "quoteOut"]);
      if (!Number.isSafeInteger(item.startedAtMs) || (item.startedAtMs as number) < 0) invalid();
      quote = { startedAtMs: item.startedAtMs as number, blockHash: hash(item.blockHash) as never,
        blockNumber: uint(item.blockNumber), inputWei: uint(item.inputWei), quoteOut: uint(item.quoteOut) };
      if (quote.inputWei !== terms.ethAmount || quote.quoteOut === 0n) invalid();
    }
    payments[hash(id)] = { operationId, paymentId: hash(pay.paymentId), terms, privateDraft,
      ...(quote === undefined ? {} : { quote }),
      ...(pay.autoMinAmountOut === undefined ? {} : { autoMinAmountOut: pay.autoMinAmountOut as boolean }),
      ...(pay.autoDeadline === undefined ? {} : { autoDeadline: pay.autoDeadline as boolean }),
      ...(pay.poolSignature === undefined ? {} : { poolSignature: hexBytes(pay.poolSignature, 65) }),
      ...(pay.paymentSignature === undefined ? {} : { paymentSignature: hexBytes(pay.paymentSignature, 65) }),
      attemptIds: array(pay.attemptIds).map(hash), txHashes: array(pay.txHashes).map(hash),
      ...(lastCheckpoint === undefined ? {} : { lastCheckpoint: {
        number: uint(lastCheckpoint.number), hash: hash(lastCheckpoint.hash) } }) };
  }
  return { revision: row.revision as number, deploymentId: row.deploymentId as string,
    recordKey: hash(row.recordKey), rewards, payments };
}
function key(value: unknown): ReceiptKeyV1 {
  const input = object(value, ["id", "secretKey", "publicKey"]);
  const secretKey = hexBytes(input.secretKey, 32);
  const publicKey = hexBytes(input.publicKey, 32);
  const privateObject = createPrivateKey({ key: Buffer.concat([privateKeyPrefix, Buffer.from(hexToBytes(secretKey))]), format: "der", type: "pkcs8" });
  const derived = createPublicKey(privateObject).export({ format: "der", type: "spki" });
  if (!Buffer.from(hexToBytes(publicKey)).equals(derived.subarray(-32))) invalid();
  return { id: hash(input.id), secretKey, publicKey };
}
function checkpoint(value: unknown): Checkpoint {
  const input = object(value, ["number", "hash", "mode"]);
  if (input.mode !== "finalized" && input.mode !== "local-simulated") invalid();
  return { number: uint(input.number), hash: hash(input.hash), mode: input.mode };
}
function utxo(value: unknown, expected: Context, owner: Address): OwnedUtxo {
  const input = object(value, ["id", "owner", "opening", "commitment", "checkpoint", "status", "chainId", "pool"]);
  if (!["available", "spent", "pending", "unknown"].includes(String(input.status))) invalid();
  const keyOwner = address(input.owner);
  const ctxPool = address(input.pool);
  const chainId = uint(input.chainId);
  const parsedOpening = opening(input.opening);
  const parsedPoint = point(input.commitment);
  const actualPoint = commit(parsedOpening);
  if (!same(keyOwner, owner) || !same(ctxPool, expected.pool) || chainId !== expected.chainId ||
      actualPoint.x !== parsedPoint.x || actualPoint.y !== parsedPoint.y) invalid();
  return { id: hash(input.id), owner: keyOwner, opening: parsedOpening, commitment: parsedPoint,
    checkpoint: checkpoint(input.checkpoint), status: input.status as OwnedUtxo["status"], chainId, pool: ctxPool };
}
function sync(value: unknown, expected: Context, owner: Address): SyncResult | null {
  if (value === null) return null;
  const base = object(value, ["status"], ["checkpoint", "utxos", "receiptFailures", "availableWei", "previous", "reason"]);
  if (base.status === "complete") {
    const input = object(value, ["status", "checkpoint", "utxos", "receiptFailures", "availableWei"]);
    const point = checkpoint(input.checkpoint);
    const utxos = array(input.utxos).map(item => utxo(item, expected, owner));
    const seen = new Set<string>();
    for (const item of utxos) { if (seen.has(item.id.toLowerCase())) invalid(); seen.add(item.id.toLowerCase()); }
    const receiptFailures = array(input.receiptFailures).map(item => {
      const failure = object(item, ["outputId", "status", "reason"]);
      if (failure.reason !== "DECRYPT" || failure.status !== "inconsistent") invalid();
      return { outputId: hash(failure.outputId), status: "inconsistent" as const, reason: "DECRYPT" as const };
    });
    const availableWei = uint(input.availableWei);
    if (availableWei !== utxos.reduce((sum, item) => sum + (item.status === "available" ? item.opening.amount : 0n), 0n)) invalid();
    return { status: "complete", checkpoint: point, utxos, receiptFailures, availableWei };
  }
  if (base.status !== "unconfirmed") invalid();
  const input = object(value, ["status", "reason"], ["checkpoint", "previous"]);
  if (!["NO_FINALITY", "CONTEXT", "INCOMPLETE_HISTORY", "INCONSISTENT_HISTORY", "RECEIPT", "RPC"].includes(String(input.reason))) invalid();
  const previous = input.previous === undefined ? undefined : object(input.previous, ["status", "checkpoint", "utxos"]);
  if (previous && previous.status !== "stale") invalid();
  return { status: "unconfirmed", reason: input.reason as Extract<SyncResult, {status:"unconfirmed"}>["reason"],
    ...(input.checkpoint === undefined ? {} : { checkpoint: checkpoint(input.checkpoint) }),
    ...(previous ? { previous: { status: "stale" as const, checkpoint: checkpoint(previous.checkpoint),
      utxos: array(previous.utxos).map(item => utxo(item, expected, owner)) } } : {}) };
}
function decodeState(bytes: Uint8Array): WalletStateV1 {
  const root = parseExactObject(bytes, ["schemaVersion", "context", "owner", "receiptKeys", "activeReceiptKeyId", "operations", "sync", "restoration", "backupCreatedAt", "connection"]);
  const input = object(root, ["schemaVersion", "context", "owner", "receiptKeys", "activeReceiptKeyId", "operations", "sync", "restoration"], ["backupCreatedAt", "connection"]);
  if (input.schemaVersion !== 1 || (input.restoration !== "ready" && input.restoration !== "needs-resync")) invalid();
  const ctx = context(input.context);
  const owner = address(input.owner);
  const receiptKeys = array(input.receiptKeys, 1000).map(key);
  const keyIds = new Set(receiptKeys.map(item => item.id.toLowerCase()));
  if (keyIds.size !== receiptKeys.length) invalid();
  const activeReceiptKeyId = input.activeReceiptKeyId === null ? null : hash(input.activeReceiptKeyId);
  if (activeReceiptKeyId && !keyIds.has(activeReceiptKeyId.toLowerCase())) invalid();
  if (input.operations === null || typeof input.operations !== "object" || Array.isArray(input.operations)) invalid();
  const records = input.operations as Record<string, unknown>;
  const operations: Record<Hex, StoredOperationV1> = {};
  const seenOperations = new Set<string>();
  for (const [mapKey, value] of Object.entries(records)) {
    const id = hash(mapKey);
    if (seenOperations.has(id.toLowerCase())) invalid();
    seenOperations.add(id.toLowerCase());
    const parsed = operation(value, ctx, owner);
    if (!same(id, parsed.fixed.operationId)) invalid();
    operations[id] = parsed;
  }
  const result: WalletStateV1 = { schemaVersion: 1, context: ctx, owner, receiptKeys, activeReceiptKeyId,
    operations, sync: sync(input.sync, ctx, owner), restoration: input.restoration };
  if (input.connection !== undefined) result.connection = connection(input.connection, ctx, owner);
  if (input.backupCreatedAt !== undefined) {
    if (typeof input.backupCreatedAt !== "string" || !Number.isFinite(Date.parse(input.backupCreatedAt))) invalid();
    result.backupCreatedAt = input.backupCreatedAt;
  }
  return result;
}
function encodeState(value: WalletStateV1): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item), "utf8");
  if (bytes.length > maxFileBytes) invalid();
  return bytes;
}
function normalized(value: WalletStateV1): WalletStateV1 {
  const bytes = encodeState(value);
  try { return decodeState(bytes); }
  finally { bytes.fill(0); }
}
async function persist(directory: string, passphrase: Uint8Array, state: WalletStateV1): Promise<void> {
  const bytes = encodeState(state);
  try { await replacePrivateFile(join(directory, fileName), await sealEnvelope(bytes, passphrase)); }
  finally { bytes.fill(0); }
}

export async function initializeOwnerState(directory: string, passphrase: Uint8Array, initial: WalletStateV1): Promise<void> {
  await createPrivateDirectory(directory);
  await withWriterLock(directory, async () => {
    const state = normalized(initial);
    try { await readPrivateFile(join(directory, fileName), maxFileBytes); invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await persist(directory, passphrase, state);
  });
}
export async function readOwnerState(directory: string, passphrase: Uint8Array, expectedContext?: Context, expectedOwner?: Address): Promise<WalletStateV1> {
  const file = await readPrivateFile(join(directory, fileName), maxFileBytes);
  const plaintext = await openEnvelope(file, passphrase);
  try {
    const state = decodeState(plaintext);
    if (expectedContext && !sameContext(expectedContext, state.context)) invalid();
    if (expectedOwner && !same(expectedOwner, state.owner)) invalid();
    return state;
  } finally { plaintext.fill(0); }
}
export async function updateOwnerState(directory: string, passphrase: Uint8Array,
  transform: (current: WalletStateV1) => WalletStateV1 | Promise<WalletStateV1>, expectedOwner?: Address): Promise<WalletStateV1> {
  return withWriterLock(directory, async () => {
    const current = await readOwnerState(directory, passphrase, undefined, expectedOwner);
    const next = normalized(await transform(structuredClone(current)));
    if (!sameContext(next.context, current.context) || !same(next.owner, current.owner)) invalid();
    await persist(directory, passphrase, next);
    return structuredClone(next);
  });
}

export function encodeOwnerSnapshot(state: WalletStateV1): Uint8Array {
  return encodeState(normalized(state));
}

export function decodeOwnerSnapshot(bytes: Uint8Array): WalletStateV1 {
  if (bytes.length > maxFileBytes) invalid();
  return decodeState(bytes);
}

export async function replaceOwnerPassphrase(directory: string, oldPassphrase: Uint8Array,
  newPassphrase: Uint8Array, expectedOwner?: Address): Promise<void> {
  await withWriterLock(directory, async () => {
    const state = await readOwnerState(directory, oldPassphrase, undefined, expectedOwner);
    await persist(directory, newPassphrase, state);
  });
}
