import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { OperationRecord, Scope } from '@confidential-utxo/uniswap';
import { getOperation, listOperations, putOperation } from '../src/store.js';

const scope = { deploymentId: 'local-v1', owner: `0x${'de'.repeat(20)}` } as Scope;
const id = `0x${'89'.repeat(32)}`;
const reader = { readInput: async () => 'owned-unspent' as const };
const aad = (owner: string, revision: number) => new TextEncoder().encode(`local-v1/${owner}/${id}/${revision}`);

async function encrypt(key: CryptoKey, owner: string, revision: number, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, revision) }, key,
    new TextEncoder().encode(text)));
  return {
    ciphertext: btoa(String.fromCharCode(...result.slice(0, -16))),
    nonce: `0x${Array.from(iv, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    tag: `0x${Array.from(result.slice(-16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  };
}

async function decrypt(key: CryptoKey, bundle: OperationRecord['encryptedBundle'], owner: string, revision: number) {
  const payload = Uint8Array.from(atob(bundle.ciphertext), (letter) => letter.charCodeAt(0));
  const tag = Uint8Array.from(bundle.tag.slice(2).match(/../g)!, (hex) => Number.parseInt(hex, 16));
  const iv = Uint8Array.from(bundle.nonce.slice(2).match(/../g)!, (hex) => Number.parseInt(hex, 16));
  const joined = new Uint8Array([...payload, ...tag]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, revision) }, key, joined));
}

it('recovers a lost ACK by recordId and decrypts only with the stored scope and revision', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const encryptedBundle = await encrypt(key, scope.owner, 1, 'local private note');
  const record = {
    scope, recordId: id, inputId: `0x${'90'.repeat(32)}`, operationId: id,
    kind: 'pay', paymentId: id, deadline: 600n, contentHash: id,
    encryptedBundle, signatureStarted: false, attemptIds: [],
  } as unknown as OperationRecord;
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('recovery-test'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record, 0, reader));
  const found = await runInDurableObject(stub, (_obj, state) => listOperations(state.storage, scope).records[0]);
  expect(found?.record.recordId).toBe(id);
  expect(await decrypt(key, found!.record.encryptedBundle, scope.owner, found!.revision)).toBe('local private note');
  await expect(decrypt(key, found!.record.encryptedBundle, `0x${'aa'.repeat(20)}`, 1)).rejects.toThrow();
  await expect(decrypt(key, found!.record.encryptedBundle, scope.owner, 2)).rejects.toThrow();
  const retry = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, record, 0, reader));
  expect(retry).toEqual(found);
  const startedRecord = { ...record, signatureStarted: true,
    encryptedBundle: await encrypt(key, scope.owner, 2, 'signature started') };
  const started = await runInDurableObject(stub, (_obj, state) => putOperation(state.storage, scope, startedRecord, 1, reader));
  expect(started.revision).toBe(2);
  expect(await decrypt(key, started.record.encryptedBundle, scope.owner, 2)).toBe('signature started');
  expect(await runInDurableObject(stub, (_obj, state) => getOperation(state.storage, scope, id)?.revision)).toBe(2);
});
