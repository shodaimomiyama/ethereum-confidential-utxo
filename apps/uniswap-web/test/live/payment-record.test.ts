import { expect, it } from 'vitest';
import { buildOperation, operationId, type Context } from '@confidential-utxo/core';
import { commit } from '@confidential-utxo/crypto';
import type { AttemptId, OperationRecord } from '@confidential-utxo/uniswap';
import { encodePaymentPrivateRecord, decodePaymentPrivateRecord, sealPaymentPrivateRecord, openPaymentPrivateRecord, appendPaymentAuthorization, createPaymentRecordEncryptor, type PaymentPrivateRecord } from '../../src/live/payment-record.js';
const hash = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const owner = `0x${'11'.repeat(20)}` as const;
const context: Context = { chainId: 31337n, pool: owner, verifier: owner, parametersHash: hash('1'), deploymentBlock: 0n, finalityMode: 'finalized' };
async function fixture() {
  const opening = { amount: 10n, blinding: 2n };
  const draft = await buildOperation({ kind: 2, owner, amount: 10n, destination: owner }, context, { randomSalt: () => new Uint8Array(32).fill(4), inputs: [{ id: hash('2'), owner, opening, commitment: commit(opening), checkpoint: { number: 1n, hash: hash('3'), mode: 'finalized' }, status: 'available', chainId: context.chainId, pool: owner }] });
  const record = { kind: 'withdraw', scope: { deploymentId: 'local', owner }, recordId: hash('4'), inputId: hash('2'), operationId: draft.operationId, contentHash: hash('5'), encryptedBundle: { nonce: '', ciphertext: '', tag: '' }, signatureStarted: false, attemptIds: [] } as unknown as OperationRecord;
  const { encryptedBundle: _, signatureStarted: __, attemptIds: ___, ...binding } = record;
  const plain: PaymentPrivateRecord = { version: 1, creationInputs: draft, binding, operationId: record.operationId, intendedAuthorization: { pool: { enum: 2, secret: new Uint8Array([1, 2]), marker: 'PRIVATE_MARKER' } }, attempts: [], recoveryMarkers: { status: 'reserved' } };
  const aad = { deploymentId: record.scope.deploymentId, owner: record.scope.owner, chainId: context.chainId, pool: record.scope.owner, recordId: record.recordId, revision: 1 };
  return { plain, record, aad };
}
it('round trips a real core draft, bigints, byte arrays and numeric enums deterministically', async () => {
  const { plain } = await fixture();
  const bytes = encodePaymentPrivateRecord(plain);
  const decoded = decodePaymentPrivateRecord(bytes);
  expect(decoded).toEqual(plain);
  expect(decoded.creationInputs.request.kind).toBe(2);
  expect(operationId(decoded.creationInputs.context, decoded.creationInputs.request)).toBe(plain.operationId);
  expect(encodePaymentPrivateRecord(decoded)).toEqual(bytes);
});
it('seals revisions and rejects cross-scope and public identity tampering', async () => {
  const { plain, record, aad } = await fixture();
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const bytes = encodePaymentPrivateRecord(plain);
  const encryptedBundle = await sealPaymentPrivateRecord(key, aad, bytes);
  expect(JSON.stringify(encryptedBundle)).not.toContain('PRIVATE_MARKER');
  expect(await openPaymentPrivateRecord(key, aad, { ...record, encryptedBundle })).toEqual(plain);
  for (const changed of [{ revision: 2 }, { chainId: 1n }, { deploymentId: 'other' }, { pool: `0x${'33'.repeat(20)}` }, { owner: `0x${'44'.repeat(20)}` }, { recordId: hash('9') }]) {
    await expect(openPaymentPrivateRecord(key, { ...aad, ...changed } as typeof aad, { ...record, encryptedBundle })).rejects.toThrow();
  }
  await expect(openPaymentPrivateRecord(key, aad, { ...record, encryptedBundle, contentHash: hash('9') } as OperationRecord)).rejects.toThrow();
  const second = await sealPaymentPrivateRecord(key, { ...aad, revision: 2 }, bytes);
  expect(await openPaymentPrivateRecord(key, { ...aad, revision: 2 }, { ...record, signatureStarted: true, encryptedBundle: second })).toEqual(plain);
});
it('retains prior attempts across encode/decode and refuses replacing fixed signatures or hashes', async () => {
  const { plain } = await fixture();
  const signatures = { pool: `0x${'11'.repeat(65)}` as const };
  const one = appendPaymentAuthorization(encodePaymentPrivateRecord(plain), signatures, 'one' as never, hash('6') as never);
  const two = appendPaymentAuthorization(one, signatures, 'two' as never, hash('7') as never);
  expect(decodePaymentPrivateRecord(two).attempts).toEqual([{ attemptId: 'one', txHash: hash('6') }, { attemptId: 'two', txHash: hash('7') }]);
  expect(() => appendPaymentAuthorization(two, { pool: `0x${'22'.repeat(65)}` })).toThrow();
  expect(() => appendPaymentAuthorization(two, signatures, 'one' as never, hash('8') as never)).toThrow();
});
it('rejects unknown versions, malformed tags, noncanonical payloads and oversized data', async () => {
  const { plain } = await fixture();
  const text = new TextDecoder().decode(encodePaymentPrivateRecord(plain));
  for (const value of ['[2,[]]', '[1,["bad"]]', text.replace('["bigint","10"]', '["bigint","010"]'), text.replace('PRIVATE_MARKER', '__proto__').replace('"marker"', '"__proto__"'), text.replace('0102', '010A'), `${text} `]) {
    expect(() => decodePaymentPrivateRecord(new TextEncoder().encode(value))).toThrow();
  }
  expect(() => decodePaymentPrivateRecord(new Uint8Array(1_048_577))).toThrow();
  expect(() => encodePaymentPrivateRecord({ ...plain, recoveryMarkers: { huge: 'x'.repeat(1_048_576) } })).toThrow();
});
it('restores all signed attempts from ciphertext and checks every public binding field', async () => {
  const { plain, record, aad } = await fixture();
  const signatures = { pool: `0x${'11'.repeat(65)}` as const };
  const one = appendPaymentAuthorization(encodePaymentPrivateRecord(plain), signatures, 'one' as never, hash('6') as never);
  const bytes = appendPaymentAuthorization(one, signatures, 'two' as never);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const encryptedBundle = await sealPaymentPrivateRecord(key, aad, bytes);
  const saved = { ...record, encryptedBundle, signatureStarted: true, attemptIds: ['one', 'two'] as AttemptId[] } as OperationRecord;
  const restored = await openPaymentPrivateRecord(key, aad, saved);
  expect(restored.signatures).toEqual(signatures);
  const continued = decodePaymentPrivateRecord(appendPaymentAuthorization(encodePaymentPrivateRecord(restored), signatures, 'two' as never, hash('7') as never));
  expect(continued.attempts).toEqual([{ attemptId: 'one', txHash: hash('6') }, { attemptId: 'two', txHash: hash('7') }]);
  for (const changed of [{ signatureStarted: false }, { attemptIds: ['one'] }, { attemptIds: ['two', 'one'] }, { inputId: hash('9') }, { operationId: hash('9') }, { recordId: hash('9') }, { scope: { ...record.scope, deploymentId: 'other' } }, { kind: 'pay', paymentId: hash('9'), deadline: 1n }]) {
    await expect(openPaymentPrivateRecord(key, aad, { ...saved, ...changed } as OperationRecord)).rejects.toThrow();
  }
});
it('preserves checksummed core addresses, and rejects changed core IDs and invalid draft shapes', async () => {
  const { plain } = await fixture();
  for (const creationInputs of [{ ...plain.creationInputs, operationId: hash('9') }, { ...plain.creationInputs, request: { ...plain.creationInputs.request, kind: '2' } }, { ...plain.creationInputs, inputOpenings: [] }]) {
    expect(() => encodePaymentPrivateRecord({ ...plain, creationInputs } as PaymentPrivateRecord)).toThrow();
  }
  const { getAddress } = await import('viem');
  const pool = getAddress(`0x${'abcdef'.repeat(6)}abcd`);
  const draft = { ...plain.creationInputs, context: { ...plain.creationInputs.context, pool } };
  draft.operationId = operationId(draft.context, draft.request);
  const updated = { ...plain, creationInputs: draft, operationId: draft.operationId, binding: { ...plain.binding, operationId: draft.operationId } } as PaymentPrivateRecord;
  expect(decodePaymentPrivateRecord(encodePaymentPrivateRecord(updated)).creationInputs.context.pool).toBe(pool);
});
it('fails closed on prototype keys, invalid UTF-8, duplicate object entries, and unsupported values', async () => {
  const { plain } = await fixture();
  const text = new TextDecoder().decode(encodePaymentPrivateRecord(plain));
  const encode = (text: string) => new TextEncoder().encode(text);
  for (const bytes of [new Uint8Array([0xff]), encode('\uFEFF' + text), encode(text.replace('["status",["string","reserved"]]', '["status",["string","reserved"]],["status",["string","reserved"]]'))]) {
    expect(() => decodePaymentPrivateRecord(bytes)).toThrow();
  }
  for (const markers of [{ __proto__: { polluted: true } }, JSON.parse('{"constructor":1}'), { unsupported: undefined }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 }, { number: -0 }]) {
    expect(() => encodePaymentPrivateRecord({ ...plain, recoveryMarkers: markers })).toThrow();
  }
});
it('captures deployment for the #55 encrypt port and binds the supplied revision', async () => {
  const { plain, record, aad } = await fixture();
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const captured = { ...aad };
  const encrypt = createPaymentRecordEncryptor(key, captured);
  captured.chainId = 1n;
  const encryptedBundle = await encrypt(encodePaymentPrivateRecord(plain), { scope: record.scope, recordId: record.recordId, revision: 2 });
  expect(await openPaymentPrivateRecord(key, { ...aad, revision: 2 }, { ...record, encryptedBundle })).toEqual(plain);
  await expect(openPaymentPrivateRecord(key, aad, { ...record, encryptedBundle })).rejects.toThrow();
  expect(() => encrypt(encodePaymentPrivateRecord(plain), { scope: { ...record.scope, deploymentId: 'other' as never }, recordId: record.recordId, revision: 2 })).toThrow();
});
it('round trips payment identity and rejects changed payment ID/deadline on open', async () => {
  const { plain, record, aad } = await fixture();
  const paymentId = hash('a') as never;
  const payRecord = { ...record, kind: 'pay', paymentId, deadline: 10n } as OperationRecord;
  const payment: PaymentPrivateRecord = { ...plain, binding: { ...plain.binding, kind: 'pay', paymentId, deadline: 10n }, paymentId,
    intendedAuthorization: { ...plain.intendedAuthorization, payment: { fixedTerms: 'delegated-to-preparer' } } };
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const encryptedBundle = await sealPaymentPrivateRecord(key, aad, encodePaymentPrivateRecord(payment));
  expect(await openPaymentPrivateRecord(key, aad, { ...payRecord, encryptedBundle })).toEqual(payment);
  for (const changed of [{ paymentId: hash('b') }, { deadline: 11n }]) {
    await expect(openPaymentPrivateRecord(key, aad, { ...payRecord, encryptedBundle, ...changed } as OperationRecord)).rejects.toThrow();
  }
});
