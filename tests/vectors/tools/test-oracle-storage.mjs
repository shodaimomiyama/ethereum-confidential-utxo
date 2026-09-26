import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, generateCases, inspectEnvelope } from './oracle-storage.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(join(root, 'cases/storage.json'), 'utf8'));
const byId = Object.fromEntries(cases.map(c => [c.id, c]));
const bytes = hex => Buffer.from(hex.slice(2), 'hex');
const good = byId['VEC-08-ENVELOPE'];

test('RFC 7914 scrypt known answer is separate from wallet profile', () => {
  const key = scryptSync('', '', 64, { N: 16, r: 1, p: 1, maxmem: 32 * 1024 * 1024 });
  assert.equal(key.toString('hex'), '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906');
});

test('fixed profile key, ciphertext, tag and exact outer bytes', async () => {
  const { input, expected } = good;
  const result = await encryptEnvelope({ passphrase: input.passphrase, salt: bytes(input.salt), nonce: bytes(input.nonce), plaintext: bytes(input.plaintext), rawHeaderBytes: bytes(input.rawHeaderBytes) });
  assert.equal(`0x${result.key.toString('hex')}`, expected.key);
  assert.equal(`0x${result.ciphertext.toString('hex')}`, expected.ciphertext);
  assert.equal(`0x${result.tag.toString('hex')}`, expected.tag);
  assert.equal(`0x${result.outerBytes.toString('hex')}`, expected.outerBytes);
  assert.deepEqual(await decryptEnvelope(result.outerBytes, input.passphrase), bytes(input.plaintext));
  const independent = createDecipheriv('aes-256-gcm', bytes(expected.key), bytes(input.nonce), { authTagLength: 16 });
  independent.setAAD(bytes(input.rawHeaderBytes));
  independent.setAuthTag(bytes(expected.tag));
  assert.deepEqual(Buffer.concat([independent.update(bytes(expected.ciphertext)), independent.final()]), bytes(input.plaintext));
});

test('changed raw header order is valid only after tag recomputation', async () => {
  const ordered = byId['VEC-08-HEADER-ORDER'];
  const { input, expected } = ordered;
  const result = await encryptEnvelope({ passphrase: input.passphrase, salt: bytes(input.salt), nonce: bytes(input.nonce), plaintext: bytes(input.plaintext), rawHeaderBytes: bytes(input.rawHeaderBytes) });
  assert.equal(`0x${result.tag.toString('hex')}`, expected.tag);
  assert.equal(`0x${result.outerBytes.toString('hex')}`, expected.outerBytes);
  assert.notEqual(expected.tag, good.expected.tag);
  assert.deepEqual(await decryptEnvelope(result.outerBytes, input.passphrase), bytes(input.plaintext));
});

test('all fixed rejection vectors reject at their assigned stage', async () => {
  for (const c of cases.filter(c => c.expected.decision === 'reject')) {
    const outer = c.input.totalBytes ? Buffer.alloc(Number(c.input.totalBytes), 0x20) : bytes(c.input.outerBytes);
    if (c.stage === 'envelope-preflight') {
      assert.throws(() => inspectEnvelope(outer), new RegExp(c.expected.reason), c.id);
      let derivations = 0;
      await assert.rejects(decryptEnvelope(outer, good.input.passphrase, { deriveKey: async () => { derivations++; throw Error('KDF called'); } }), new RegExp(c.expected.reason), c.id);
      assert.equal(derivations, 0, c.id);
    } else {
      assert.doesNotThrow(() => inspectEnvelope(outer), c.id);
      await assert.rejects(decryptEnvelope(outer, c.input.passphrase ?? good.input.passphrase), new RegExp(c.expected.reason), c.id);
    }
  }
});

test('fresh generation reproduces committed cases byte for byte', async () => {
  assert.deepEqual(await generateCases(), cases);
});

test('oversize is rejected before parsing or KDF', async () => {
  const outer = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  let calls = 0;
  await assert.rejects(decryptEnvelope(outer, 'test', { deriveKey: async () => { calls++; return Buffer.alloc(32); } }), /size limit/);
  assert.equal(calls, 0);
});
