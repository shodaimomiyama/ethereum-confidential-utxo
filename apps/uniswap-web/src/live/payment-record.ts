import { operationId as coreOperationId, outputId, validateOperationShape, type LocalDraft } from '@confidential-utxo/core';
import type { AttemptId, AuthorizationSignatures, Bytes32, OperationRecord, PaymentPorts, TxHash } from '@confidential-utxo/uniswap';
import { openRecord, sealRecord, type RecordContext } from './record-crypto.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
type Binding = OperationRecord extends infer R ? R extends OperationRecord ? Omit<R, 'encryptedBundle' | 'signatureStarted' | 'attemptIds'> : never : never;

/**
 * Adapter-owned format; #55 does not define the contents of privateBytes.
 * The preparer must bind this snapshot to its core draft, public record and exact
 * pool/payment authorization payloads after the published preparation checks.
 * This codec checks transport structure and IDs, not proofs or payment decisions.
 */
export interface PaymentPrivateRecord {
  readonly version: 1;
  readonly creationInputs: LocalDraft;
  readonly binding: Binding;
  readonly operationId: Bytes32 | OperationRecord['operationId'];
  readonly paymentId?: Bytes32 | Extract<OperationRecord, { kind: 'pay' }>['paymentId'];
  readonly intendedAuthorization: { readonly pool: Readonly<Record<string, unknown>>; readonly payment?: Readonly<Record<string, unknown>> };
  readonly signatures?: AuthorizationSignatures;
  readonly attempts: readonly { readonly attemptId: AttemptId; readonly txHash?: TxHash }[];
  readonly recoveryMarkers: Readonly<Record<string, unknown>>;
}
function invalid(): never { throw new Error('INVALID_PAYMENT_RECORD'); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}
function hex(value: unknown, length?: number): asserts value is `0x${string}` {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(value) || (length !== undefined && value.length !== 2 + length * 2)) invalid();
}
function address(value: unknown): asserts value is `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid();
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(pack(a)) === JSON.stringify(pack(b)); }

// Every value is tagged, so user objects cannot impersonate bigint/byte-array tags.
function pack(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) invalid();
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (typeof value === 'bigint') return ['bigint', value.toString(10)];
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return ['number', value.toString(10)];
  }
  if (value instanceof Uint8Array) return ['bytes', Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')];
  if (Array.isArray(value)) return ['array', Array.from(value, item => pack(item, depth + 1))];
  const data = object(value);
  if (Object.getOwnPropertySymbols(data).length) invalid();
  return ['object', Object.keys(data).sort().map(key => {
    if (forbidden.has(key) || !('value' in Object.getOwnPropertyDescriptor(data, key)!)) invalid();
    return [key, pack(data[key], depth + 1)];
  })];
}
function unpack(node: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || !Array.isArray(node)) invalid();
  const [tag, value] = node;
  if (tag === 'null' && node.length === 1) return null;
  if (node.length !== 2) invalid();
  if (tag === 'string' && typeof value === 'string') return value;
  if (tag === 'boolean' && typeof value === 'boolean') return value;
  if ((tag === 'bigint' || tag === 'number') && typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    if (tag === 'bigint') return BigInt(value);
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    invalid();
  }
  if (tag === 'bytes' && typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value)) {
    return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
  }
  if (tag === 'array' && Array.isArray(value)) return value.map(item => unpack(item, depth + 1));
  if (tag === 'object' && Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    let previous: string | undefined;
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || forbidden.has(entry[0]) || (previous !== undefined && previous >= entry[0])) invalid();
      previous = entry[0];
      result[entry[0]] = unpack(entry[1], depth + 1);
    }
    return result;
  }
  invalid();
}
function keys(data: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function bigints(value: unknown, fields: string[]): void {
  const data = object(value);
  keys(data, fields);
  for (const field of fields) if (typeof data[field] !== 'bigint' || data[field] < 0n) invalid();
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function validateDraft(value: unknown): asserts value is LocalDraft {
  const draft = object(value);
  keys(draft, ['context', 'request', 'operationId', 'outputIds', 'openings', 'inputOpenings', 'balanceProof', 'rangeProofs'], ['signature']);
  const context = object(draft.context);
  keys(context, ['chainId', 'pool', 'deploymentBlock', 'verifier', 'parametersHash', 'finalityMode']);
  if (typeof context.chainId !== 'bigint' || context.chainId <= 0n || typeof context.deploymentBlock !== 'bigint' || context.deploymentBlock < 0n
    || !['finalized', 'local-simulated'].includes(context.finalityMode as string)) invalid();
  address(context.pool); address(context.verifier); hex(context.parametersHash, 32);
  const request = object(draft.request);
  keys(request, ['kind', 'owner', 'salt', 'inputIds', 'outputs', 'd', 'w', 'destination']);
  if (![0, 1, 2].includes(request.kind as number) || typeof request.d !== 'bigint' || typeof request.w !== 'bigint') invalid();
  address(request.owner); hex(request.salt, 32); address(request.destination);
  array(request.inputIds).forEach(id => hex(id, 32));
  array(request.outputs).forEach(output => {
    const item = object(output); keys(item, ['owner', 'commitment', 'receiptFormat', 'packet']);
    address(item.owner); hex(item.packet); if (item.receiptFormat !== 1) invalid(); bigints(item.commitment, ['x', 'y']);
  });
  hex(draft.operationId, 32); array(draft.outputIds).forEach(id => hex(id, 32));
  array(draft.openings).forEach(opening => bigints(opening, ['amount', 'blinding']));
  array(draft.inputOpenings).forEach(opening => bigints(opening, ['amount', 'blinding']));
  bigints(draft.balanceProof, ['Rx', 'Ry', 's']);
  array(draft.rangeProofs).forEach(proof => {
    const data = object(proof); keys(data, ['coords', 'scalars', 'ls', 'rs']);
    for (const field of ['coords', 'scalars', 'ls', 'rs']) array(data[field]).forEach(number => { if (typeof number !== 'bigint' || number < 0n) invalid(); });
  });
  if (draft.signature !== undefined) hex(draft.signature, 65);
  const typed = value as LocalDraft;
  validateOperationShape(typed.request);
  if (coreOperationId(typed.context, typed.request) !== typed.operationId || typed.openings.length !== typed.request.outputs.length
    || typed.inputOpenings.length !== typed.request.inputIds.length || typed.rangeProofs.length !== typed.request.outputs.length
    || typed.outputIds.length !== typed.request.outputs.length || typed.outputIds.some((id, i) => id !== outputId(typed.operationId, i))) invalid();
}
function validate(value: unknown): PaymentPrivateRecord {
  const data = object(value);
  keys(data, ['version', 'creationInputs', 'binding', 'operationId', 'intendedAuthorization', 'attempts', 'recoveryMarkers'], ['paymentId', 'signatures']);
  if (data.version !== 1) invalid();
  validateDraft(data.creationInputs);
  const binding = object(data.binding);
  if (binding.kind !== 'pay' && binding.kind !== 'withdraw') invalid();
  keys(binding, ['kind', 'scope', 'recordId', 'inputId', 'operationId', 'contentHash', ...(binding.kind === 'pay' ? ['paymentId', 'deadline'] : [])]);
  const scope = object(binding.scope); keys(scope, ['deploymentId', 'owner']);
  if (typeof scope.deploymentId !== 'string' || !/^[\x20-\x7e]+$/.test(scope.deploymentId)) invalid();
  address(scope.owner);
  for (const field of ['recordId', 'inputId', 'operationId', 'contentHash']) hex(binding[field], 32);
  hex(data.operationId, 32);
  const auth = object(data.intendedAuthorization); keys(auth, ['pool'], ['payment']); object(auth.pool);
  if (binding.kind === 'pay') {
    hex(binding.paymentId, 32); hex(data.paymentId, 32);
    if (data.paymentId !== binding.paymentId || typeof binding.deadline !== 'bigint' || binding.deadline <= 0n) invalid();
    object(auth.payment);
  } else if (data.paymentId !== undefined || auth.payment !== undefined) invalid();
  if (data.operationId !== binding.operationId || data.creationInputs.operationId !== binding.operationId
    || data.creationInputs.request.owner.toLowerCase() !== scope.owner.toLowerCase() || data.creationInputs.request.inputIds.length !== 1
    || data.creationInputs.request.inputIds[0] !== binding.inputId || data.creationInputs.request.kind !== 2) invalid();
  if (data.signatures !== undefined) {
    const signatures = object(data.signatures); keys(signatures, ['pool'], ['payment']); hex(signatures.pool, 65);
    if (binding.kind === 'pay') hex(signatures.payment, 65); else if (signatures.payment !== undefined) invalid();
    if (data.creationInputs.signature !== undefined && data.creationInputs.signature !== signatures.pool) invalid();
  } else if (data.creationInputs.signature !== undefined) invalid();
  const ids = new Set();
  array(data.attempts).forEach(attempt => {
    const item = object(attempt); keys(item, ['attemptId'], ['txHash']);
    if (typeof item.attemptId !== 'string' || !item.attemptId || ids.has(item.attemptId) || data.signatures === undefined) invalid();
    ids.add(item.attemptId); if (item.txHash !== undefined) hex(item.txHash, 32);
  });
  object(data.recoveryMarkers);
  return value as PaymentPrivateRecord;
}
export function encodePaymentPrivateRecord(record: PaymentPrivateRecord): Uint8Array<ArrayBuffer> {
  const text = JSON.stringify([1, pack(record)]);
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_BYTES) throw new Error('RECORD_TOO_LARGE');
  validate(record);
  return bytes;
}
export function decodePaymentPrivateRecord(bytes: Uint8Array): PaymentPrivateRecord {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw new Error('RECORD_TOO_LARGE');
  const text = decoder.decode(bytes);
  const root: unknown = JSON.parse(text);
  if (!Array.isArray(root) || root.length !== 2 || root[0] !== 1) invalid();
  const record = validate(unpack(root[1]));
  if (JSON.stringify([1, pack(record)]) !== text) invalid();
  return record;
}
function assertContext(record: PaymentPrivateRecord, context: RecordContext): void {
  const { binding, creationInputs } = record;
  if (binding.scope.deploymentId !== context.deploymentId || binding.scope.owner.toLowerCase() !== context.owner.toLowerCase()
    || binding.recordId !== context.recordId.toLowerCase() || creationInputs.context.chainId !== context.chainId
    || creationInputs.context.pool.toLowerCase() !== context.pool.toLowerCase()) invalid();
}
export async function sealPaymentPrivateRecord(key: CryptoKey, context: RecordContext, bytes: Uint8Array) {
  const record = decodePaymentPrivateRecord(bytes); assertContext(record, context);
  // Task6 canonicalizes numbers and bigints. Tagged text retains their exact types.
  return sealRecord(key, context, { version: 1, creationInputs: decoder.decode(bytes), operationId: record.operationId as Bytes32,
    ...(record.paymentId === undefined ? {} : { paymentId: record.paymentId as Bytes32 }),
    intendedAuthorization: { payload: pack(record.intendedAuthorization), signatures: record.signatures ?? null }, attempts: record.attempts,
    recoveryMarkers: pack(record.recoveryMarkers) });
}
function samePublicBinding(a: Binding, b: Binding): boolean {
  // Service reads rebuild scope using the request's address spelling.
  const normalizeOwner = (binding: Binding) => ({ ...binding,
    scope: { ...binding.scope, owner: binding.scope.owner.toLowerCase() } });
  return same(normalizeOwner(a), normalizeOwner(b));
}
export async function openPaymentPrivateRecord(key: CryptoKey, context: RecordContext, publicRecord: OperationRecord): Promise<PaymentPrivateRecord> {
  const plain = await openRecord(key, context, publicRecord.encryptedBundle);
  if (typeof plain.creationInputs !== 'string') invalid();
  const record = decodePaymentPrivateRecord(encoder.encode(plain.creationInputs)); assertContext(record, context);
  const { encryptedBundle: _, signatureStarted, attemptIds, ...binding } = publicRecord;
  if (!samePublicBinding(binding, record.binding) || !same(attemptIds, record.attempts.map(attempt => attempt.attemptId))
    || (record.signatures !== undefined && !signatureStarted) || plain.operationId !== record.operationId || plain.paymentId !== record.paymentId
    || !same(plain.intendedAuthorization, { payload: pack(record.intendedAuthorization), signatures: record.signatures ?? null }) || !same(plain.attempts, record.attempts)
    || !same(plain.recoveryMarkers, pack(record.recoveryMarkers))) invalid();
  return record;
}
/**
 * Building block for PaymentPorts.sealContent. The binding must pass the latest
 * returned bytes on every call, including after restoring an encrypted revision;
 * repeatedly passing immutable prepared.privateBytes would discard prior attempts.
 * Each result contains the complete history and fixed signatures for persistence.
 */
export function appendPaymentAuthorization(bytes: Uint8Array, signatures: AuthorizationSignatures, attemptId?: AttemptId, txHash?: TxHash): Uint8Array<ArrayBuffer> {
  const record = decodePaymentPrivateRecord(bytes);
  if (record.signatures !== undefined && !same(record.signatures, signatures)) invalid();
  if (txHash !== undefined && attemptId === undefined) invalid();
  const attempts = record.attempts.map(attempt => ({ ...attempt }));
  if (attemptId !== undefined) {
    const previous = attempts.find(attempt => attempt.attemptId === attemptId);
    if (previous) {
      if (previous.txHash !== undefined && txHash !== undefined && previous.txHash !== txHash) invalid();
      if (txHash !== undefined) previous.txHash = txHash;
    } else attempts.push({ attemptId, ...(txHash === undefined ? {} : { txHash }) });
  }
  return encodePaymentPrivateRecord({ ...record, signatures, attempts });
}
/** Capture the deployment at session creation; #55 supplies only scope, record ID and revision. */
export function createPaymentRecordEncryptor(key: CryptoKey, deployment: Pick<RecordContext, 'deploymentId' | 'chainId' | 'pool' | 'owner'>): PaymentPorts['encrypt'] {
  const captured = { ...deployment };
  return (bytes, context) => {
    if (context.scope.deploymentId !== captured.deploymentId || context.scope.owner.toLowerCase() !== captured.owner.toLowerCase()) invalid();
    return sealPaymentPrivateRecord(key, { ...captured, recordId: context.recordId, revision: context.revision }, bytes);
  };
}
