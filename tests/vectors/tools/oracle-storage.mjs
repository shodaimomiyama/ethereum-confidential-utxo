import { createCipheriv, createDecipheriv, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const MAX_FILE = 16 * 1024 * 1024;
const PROFILE = 'scrypt-aes256gcm-v1';
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 268435456 };
const decoder = new TextDecoder('utf-8', { fatal: true });
const b64 = b => Buffer.from(b).toString('base64');
const hex = b => `0x${Buffer.from(b).toString('hex')}`;

function objectWithExactKeys(raw, names, label) {
  let value;
  try { value = JSON.parse(decoder.decode(raw)); }
  catch { throw new Error(`${label} invalid UTF-8 or JSON`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be object`);
  // JSON.parse silently accepts duplicate keys, so walk the raw string's object keys.
  const string = decoder.decode(raw);
  let cursor = 0;
  const skip = () => { while (/\s/.test(string[cursor] ?? '') && cursor < string.length) cursor++; };
  const quoted = () => {
    if (string[cursor] !== '"') throw new Error(`${label} invalid JSON field`);
    const start = cursor++;
    let escaped = false;
    while (cursor < string.length) {
      const char = string[cursor++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return JSON.parse(string.slice(start, cursor));
    }
    throw new Error(`${label} invalid JSON string`);
  };
  skip(); cursor++; skip();
  const seen = new Set();
  while (string[cursor] !== '}' && cursor < string.length) {
    const key = quoted(); skip();
    if (string[cursor++] !== ':') throw new Error(`${label} invalid JSON field`);
    skip();
    // Both envelope levels have scalar values only. This also prevents nested ambiguity.
    if (string[cursor] === '"') quoted();
    else {
      const start = cursor;
      while (cursor < string.length && !/[},\s]/.test(string[cursor])) cursor++;
      if (cursor === start) throw new Error(`${label} invalid JSON field`);
    }
    if (seen.has(key)) throw new Error(`${label} duplicate key`);
    if (!names.includes(key)) throw new Error(`${label} unknown key`);
    seen.add(key); skip();
    if (string[cursor] === ',') { cursor++; skip(); }
    else break;
  }
  if (seen.size !== names.length || string[cursor] !== '}') throw new Error(`${label} missing or invalid key`);
  cursor++; skip();
  if (cursor !== string.length) throw new Error(`${label} invalid trailing data`);
  return value;
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${label} invalid base64`);
  const bytes = Buffer.from(value, 'base64');
  if (b64(bytes) !== value) throw new Error(`${label} invalid base64`);
  return bytes;
}

export function inspectEnvelope(outerBytes) {
  if (!Buffer.isBuffer(outerBytes)) throw new TypeError('outerBytes must be Buffer');
  if (outerBytes.length > MAX_FILE) throw new Error('size limit exceeded');
  const outer = objectWithExactKeys(outerBytes, ['header', 'ciphertext', 'tag'], 'outer');
  const rawHeaderBytes = decodeBase64(outer.header, 'header');
  const header = objectWithExactKeys(rawHeaderBytes, ['version', 'profile', 'salt', 'nonce'], 'header');
  if (header.version !== 1) throw new Error('unknown version');
  if (header.profile !== PROFILE) throw new Error('unknown profile');
  const salt = decodeBase64(header.salt, 'salt');
  const nonce = decodeBase64(header.nonce, 'nonce');
  const ciphertext = decodeBase64(outer.ciphertext, 'ciphertext');
  const tag = decodeBase64(outer.tag, 'tag');
  if (salt.length !== 16) throw new Error('salt length');
  if (nonce.length !== 12) throw new Error('nonce length');
  if (tag.length !== 16) throw new Error('tag length');
  return { rawHeaderBytes, salt, nonce, ciphertext, tag };
}

export async function deriveStorageKey(passphrase, salt) {
  if (typeof passphrase !== 'string') throw new TypeError('passphrase must be string');
  return scrypt(Buffer.from(passphrase, 'utf8'), salt, 32, OPTIONS);
}

export async function encryptEnvelope({ passphrase, salt, nonce, plaintext, rawHeaderBytes }) {
  const header = objectWithExactKeys(rawHeaderBytes, ['version', 'profile', 'salt', 'nonce'], 'header');
  if (header.version !== 1 || header.profile !== PROFILE || header.salt !== b64(salt) || header.nonce !== b64(nonce)) throw new Error('header mismatch');
  if (salt.length !== 16 || nonce.length !== 12 || !Buffer.isBuffer(plaintext)) throw new Error('invalid encryption input');
  const key = await deriveStorageKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(rawHeaderBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const outerBytes = Buffer.from(JSON.stringify({ header: b64(rawHeaderBytes), ciphertext: b64(ciphertext), tag: b64(tag) }), 'utf8');
  if (outerBytes.length > MAX_FILE) throw new Error('size limit exceeded');
  return { key, ciphertext, tag, outerBytes };
}

export async function decryptEnvelope(outerBytes, passphrase, { deriveKey = deriveStorageKey } = {}) {
  const { rawHeaderBytes, salt, nonce, ciphertext, tag } = inspectEnvelope(outerBytes);
  const key = await deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(rawHeaderBytes);
    decipher.setAuthTag(tag);
    // Do not expose update() output before final() authenticates the whole message.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new Error('authentication failed'); }
}

const source = 'docs/design.md#保存profile-v1';
const consumers = ['#30'];
const input = {
  passphrase: 'test-only passphrase',
  salt: '0x000102030405060708090a0b0c0d0e0f',
  nonce: '0x101112131415161718191a1b',
  plaintext: hex(Buffer.from('{"test":"wallet bytes, not an inner schema"}', 'utf8')),
};
const rawHeader = (salt, nonce, reordered = false) => Buffer.from(reordered
  ? JSON.stringify({ nonce: b64(nonce), salt: b64(salt), profile: PROFILE, version: 1 })
  : JSON.stringify({ version: 1, profile: PROFILE, salt: b64(salt), nonce: b64(nonce) }), 'utf8');

export async function generateCases() {
  const salt = Buffer.from(input.salt.slice(2), 'hex');
  const nonce = Buffer.from(input.nonce.slice(2), 'hex');
  const plaintext = Buffer.from(input.plaintext.slice(2), 'hex');
  const normal = await encryptEnvelope({ passphrase: input.passphrase, salt, nonce, plaintext, rawHeaderBytes: rawHeader(salt, nonce) });
  const reordered = await encryptEnvelope({ passphrase: input.passphrase, salt, nonce, plaintext, rawHeaderBytes: rawHeader(salt, nonce, true) });
  const accepted = (id, result, headerBytes, passphrase = input.passphrase) => ({ id, profile: 'scrypt-aes256gcm-v1', source, stage: 'envelope-crypto', input: { ...input, passphrase, rawHeaderBytes: hex(headerBytes) }, expected: { decision: 'accept', key: hex(result.key), ciphertext: hex(result.ciphertext), tag: hex(result.tag), outerBytes: hex(result.outerBytes) }, oracle: 'Node.js 24.21.0 crypto; RFC 7914 scrypt cross-check', consumers });
  const cases = [accepted('VEC-08-ENVELOPE', normal, rawHeader(salt, nonce)), accepted('VEC-08-HEADER-ORDER', reordered, rawHeader(salt, nonce, true))];
  cases[1].baseCase = cases[0].id;
  cases[1].mutatedField = 'input.rawHeaderBytes';
  const outer = JSON.parse(normal.outerBytes.toString('utf8'));
  const header = JSON.parse(rawHeader(salt, nonce).toString('utf8'));
  const mutate = (name, patch, reason, stage = 'envelope-preflight', passphrase = input.passphrase) => {
    const outerBytes = Buffer.isBuffer(patch) ? patch : Buffer.from(JSON.stringify(patch), 'utf8');
    cases.push({ id: `VEC-08-${name}`, profile: 'scrypt-aes256gcm-v1', source, stage, baseCase: cases[0].id, mutatedField: name.toLowerCase(), input: { outerBytes: hex(outerBytes), passphrase }, expected: { decision: 'reject', reason }, oracle: 'Node.js 24.21.0 crypto; strict preflight', consumers });
  };
  const headerPatch = fields => ({ ...outer, header: b64(Buffer.from(JSON.stringify({ ...header, ...fields }), 'utf8')) });
  mutate('RAW-HEADER-TAMPER', { ...outer, header: b64(rawHeader(salt, nonce, true)) }, 'authentication failed', 'envelope-auth');
  mutate('WRONG-PASSPHRASE', outer, 'authentication failed', 'envelope-auth', 'wrong passphrase');
  mutate('TAG-TAMPER', { ...outer, tag: b64(Buffer.alloc(16, 0)) }, 'authentication failed', 'envelope-auth');
  mutate('CIPHERTEXT-TAMPER', { ...outer, ciphertext: b64(Buffer.alloc(Buffer.from(outer.ciphertext, 'base64').length, 0)) }, 'authentication failed', 'envelope-auth');
  mutate('UNKNOWN-VERSION', headerPatch({ version: 2 }), 'unknown version');
  mutate('UNKNOWN-PROFILE', headerPatch({ profile: 'future' }), 'unknown profile');
  mutate('OUTER-DUPLICATE', Buffer.from(normal.outerBytes.toString('utf8').replace('"tag":', `"tag":"${outer.tag}","tag":`)), 'outer duplicate key');
  mutate('HEADER-DUPLICATE', { ...outer, header: b64(Buffer.from(rawHeader(salt, nonce).toString('utf8').replace('"nonce":', `"nonce":"${header.nonce}","nonce":`))) }, 'header duplicate key');
  mutate('OUTER-UNKNOWN', { ...outer, extra: 'x' }, 'outer unknown key');
  mutate('HEADER-UNKNOWN', headerPatch({ extra: 'x' }), 'header unknown key');
  mutate('INVALID-UTF8', Buffer.from([0xff]), 'outer invalid UTF-8 or JSON');
  mutate('INVALID-BASE64', { ...outer, ciphertext: '*' }, 'ciphertext invalid base64');
  mutate('INVALID-PADDING', { ...outer, tag: outer.tag.replace(/=$/, '') }, 'tag invalid base64');
  mutate('INVALID-TYPE', { ...outer, ciphertext: 42 }, 'ciphertext invalid base64');
  mutate('SHORT-NONCE', headerPatch({ nonce: b64(Buffer.alloc(11)) }), 'nonce length');
  mutate('SHORT-SALT', headerPatch({ salt: b64(Buffer.alloc(15)) }), 'salt length');
  mutate('SHORT-TAG', { ...outer, tag: b64(Buffer.alloc(15)) }, 'tag length');
  cases.push({ id: 'VEC-08-OVERSIZE', profile: 'scrypt-aes256gcm-v1', source, stage: 'envelope-preflight', baseCase: cases[0].id, mutatedField: 'input.totalBytes', input: { repeatByte: '0x20', totalBytes: String(MAX_FILE + 1), passphrase: input.passphrase }, expected: { decision: 'reject', reason: 'size limit exceeded' }, oracle: 'Node.js 24.21.0 crypto; strict preflight', consumers });
  const headerBytes = rawHeader(salt, nonce);
  for (const [suffix, passphrase] of [
    ['WHITESPACE', ` ${input.passphrase} `],
    ['NFC', 'caf\u00e9'],
    ['NFD', 'cafe\u0301'],
  ]) {
    const result = await encryptEnvelope({ passphrase, salt, nonce, plaintext, rawHeaderBytes: headerBytes });
    const c = accepted(`VEC-08-PASSPHRASE-${suffix}`, result, headerBytes, passphrase);
    c.baseCase = cases[0].id;
    c.mutatedField = 'input.passphrase';
    cases.push(c);
  }
  mutate('OUTER-MALFORMED-JSON', Buffer.from('{"header":', 'utf8'), 'outer invalid UTF-8 or JSON');
  return cases;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--out');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: oracle-storage.mjs --out <directory>');
  const out = resolve(process.argv[index + 1]);
  if (out === resolve(fileURLToPath(new URL('../cases', import.meta.url)))) {
    throw new Error('choose a separate output directory');
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'storage.json'), `${JSON.stringify(await generateCases(), null, 2)}\n`);
}
