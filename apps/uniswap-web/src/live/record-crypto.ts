import type { Address, Bytes32, DeploymentId, EncryptedBundle, OperationRecord, OperationResponse, WireOperationRecord } from '@confidential-utxo/uniswap';
import { HttpFailure, sameScope, type HttpClient } from './http.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_BYTES = 1_048_576;
const usedNonces = new WeakMap<CryptoKey, Set<string>>();

export interface RecordContext {
  readonly deploymentId: DeploymentId;
  readonly chainId: bigint;
  readonly pool: Address;
  readonly owner: Address;
  readonly recordId: Bytes32;
  readonly revision: number;
}

export interface PlainRecord {
  readonly version: 1;
  readonly creationInputs: unknown;
  readonly operationId: Bytes32;
  readonly paymentId?: Bytes32;
  readonly intendedAuthorization: unknown;
  readonly attempts: readonly unknown[];
  readonly recoveryMarkers: unknown;
}

function hexBytes(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(value)) throw new Error('INVALID_RECORD');
  return Uint8Array.from({ length }, (_, i) => Number.parseInt(value.slice(2 + 2 * i, 4 + 2 * i), 16));
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('INVALID_RECORD');
    return value.toString(10);
  }
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) continue;
      sorted[key] = canonical(object[key]);
    }
    return sorted;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value.toString(10);
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  throw new Error('INVALID_RECORD');
}

function validatePlain(value: unknown): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RECORD');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.creationInputs || !record.intendedAuthorization
    || !Array.isArray(record.attempts) || !record.recoveryMarkers) throw new Error('INVALID_RECORD');
  hexBytes(record.operationId as string, 32);
  if (record.paymentId !== undefined) hexBytes(record.paymentId as string, 32);
  return value as PlainRecord;
}

/** Version byte, five length-prefixed fields, then unsigned 64-bit revision. */
export function encodeRecordAad(context: RecordContext): Uint8Array<ArrayBuffer> {
  const deployment = context.deploymentId.normalize('NFC');
  if (!deployment || deployment !== context.deploymentId || !/^[\x20-\x7e]+$/.test(deployment)
    || context.chainId <= 0n || context.chainId > (1n << 64n) - 1n
    || !Number.isSafeInteger(context.revision) || context.revision < 1) throw new Error('INVALID_RECORD_CONTEXT');
  const chain = encoder.encode(context.chainId.toString(10));
  const fields = [encoder.encode(deployment), chain,
    hexBytes(context.pool.toLowerCase(), 20), hexBytes(context.owner.toLowerCase(), 20),
    hexBytes(context.recordId.toLowerCase(), 32)];
  const size = 1 + fields.reduce((sum, field) => sum + 4 + field.length, 0) + 8;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  let offset = 1;
  for (const field of fields) {
    view.setUint32(offset, field.length, false); offset += 4;
    bytes.set(field, offset); offset += field.length;
  }
  view.setBigUint64(offset, BigInt(context.revision), false);
  return bytes;
}

function base64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('INVALID_RECORD');
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function sealRecord(
  key: CryptoKey, context: RecordContext, plaintext: PlainRecord,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = bytes => crypto.getRandomValues(bytes),
): Promise<EncryptedBundle> {
  const normalized = validatePlain({ ...(canonical(plaintext) as object), version: plaintext.version });
  const plain = encoder.encode(JSON.stringify(normalized));
  if (plain.length > MAX_BYTES) throw new Error('RECORD_TOO_LARGE');
  const nonce = new Uint8Array(random(new Uint8Array(12)));
  if (nonce.length !== 12) throw new Error('INVALID_NONCE');
  const nonceHex = hex(nonce);
  let seen = usedNonces.get(key);
  if (!seen) { seen = new Set(); usedNonces.set(key, seen); }
  if (seen.has(nonceHex)) throw new Error('NONCE_REUSED');
  seen.add(nonceHex);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: encodeRecordAad(context), tagLength: 128 }, key, plain));
  return { nonce: nonceHex, ciphertext: base64(sealed.subarray(0, -16)), tag: hex(sealed.subarray(-16)) };
}

export async function openRecord(key: CryptoKey, context: RecordContext, bundle: EncryptedBundle): Promise<PlainRecord> {
  const ciphertext = fromBase64(bundle.ciphertext);
  if (ciphertext.length > MAX_BYTES) throw new Error('RECORD_TOO_LARGE');
  const joined = new Uint8Array(ciphertext.length + 16);
  joined.set(ciphertext);
  joined.set(hexBytes(bundle.tag, 16), ciphertext.length);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexBytes(bundle.nonce, 12),
    additionalData: encodeRecordAad(context), tagLength: 128 }, key, joined);
  return validatePlain(JSON.parse(decoder.decode(bytes)));
}

function sameRecord(a: OperationRecord, b: OperationRecord): boolean {
  return a.kind === b.kind && sameScope(a.scope, b.scope)
    && a.recordId.toLowerCase() === b.recordId.toLowerCase()
    && a.inputId.toLowerCase() === b.inputId.toLowerCase()
    && a.operationId.toLowerCase() === b.operationId.toLowerCase()
    && a.contentHash.toLowerCase() === b.contentHash.toLowerCase()
    && a.signatureStarted === b.signatureStarted
    && a.attemptIds.length === b.attemptIds.length
    && a.attemptIds.every((id, index) => id === b.attemptIds[index])
    && a.encryptedBundle.nonce === b.encryptedBundle.nonce
    && a.encryptedBundle.ciphertext === b.encryptedBundle.ciphertext
    && a.encryptedBundle.tag === b.encryptedBundle.tag
    && (a.kind !== 'pay' || (b.kind === 'pay' && a.paymentId.toLowerCase() === b.paymentId.toLowerCase()
      && a.deadline === b.deadline));
}

function confirmed(saved: OperationResponse, record: OperationRecord, bundleRevision: number): OperationResponse {
  if (saved.revision !== bundleRevision || !sameRecord(saved.record, record)) throw new Error('OPERATION_SAVE_UNCONFIRMED');
  return saved;
}

export async function saveBeforeAuthorization(
  http: HttpClient, record: OperationRecord, expectedRevision: number,
  options?: { readonly bundleRevision: number },
): Promise<OperationResponse> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('INVALID_REVISION');
  // A new bundle targets the next revision. Replaying a byte-identical saved bundle
  // may target the current revision, but the caller must state that AAD revision.
  const bundleRevision = options?.bundleRevision ?? expectedRevision + 1;
  if (!Number.isSafeInteger(bundleRevision) || bundleRevision < 1
    || (bundleRevision !== expectedRevision + 1 && bundleRevision !== expectedRevision)) {
    throw new Error('INVALID_REVISION');
  }
  const { scope } = record;
  const wireRecord: WireOperationRecord = record.kind === 'pay'
    ? { kind: 'pay', recordId: record.recordId, inputId: record.inputId, operationId: record.operationId,
      contentHash: record.contentHash, encryptedBundle: record.encryptedBundle,
      signatureStarted: record.signatureStarted, attemptIds: record.attemptIds,
      paymentId: record.paymentId, deadline: record.deadline.toString(10) }
    : { kind: 'withdraw', recordId: record.recordId, inputId: record.inputId, operationId: record.operationId,
      contentHash: record.contentHash, encryptedBundle: record.encryptedBundle,
      signatureStarted: record.signatureStarted, attemptIds: record.attemptIds };
  if (bundleRevision === expectedRevision) {
    const found = await http.call('GET /v1/operations/{id}', { scope, id: record.recordId });
    if (!sameScope(found.scope, scope) || found.reservationState !== 'active') {
      throw new Error('OPERATION_SAVE_UNCONFIRMED');
    }
    return confirmed(found, record, bundleRevision);
  }
  try {
    const saved = await http.call('PUT /v1/operations/{id}', { scope, id: record.recordId,
      body: { scope, expectedRevision, sealedRevision: bundleRevision, record: wireRecord } });
    if (!sameScope(saved.scope, scope)) throw new Error('OPERATION_SAVE_UNCONFIRMED');
    return confirmed(saved, record, bundleRevision);
  } catch (error) {
    if (error instanceof HttpFailure && (error.kind === 'api' || error.kind === 'scope')) throw error;
    if (error instanceof Error && error.message === 'OPERATION_SAVE_UNCONFIRMED') throw error;
    const found = await http.call('GET /v1/operations/{id}', { scope, id: record.recordId });
    if (!sameScope(found.scope, scope) || found.reservationState !== 'active') {
      throw new Error('OPERATION_SAVE_UNCONFIRMED');
    }
    return confirmed(found, record, bundleRevision);
  }
}
