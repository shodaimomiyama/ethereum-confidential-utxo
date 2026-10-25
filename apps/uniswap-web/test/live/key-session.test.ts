import { createHash, hkdfSync } from 'node:crypto';
import { CipherSuite, HkdfSha256, Aes128Gcm } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { keccak256, stringToHex, hexToBytes, bytesToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';
import type { Address, DeploymentId } from '@confidential-utxo/uniswap';
import type { WalletEvent, WalletPort } from '../../src/live/wallet.js';
import { createKeySession, recipientMessage } from '../../src/live/key-session.js';

const account = privateKeyToAccount(keccak256(stringToHex('synthetic key-session test account')));
const owner = account.address.toLowerCase() as Address;
const pool = `0x${'ab'.repeat(20)}` as Address;
const scope = { deploymentId: 'test' as DeploymentId, owner };
const location = { chainId: 1n, pool };
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const sign = () => account.signMessage({ message: { raw: recipientMessage(1n, pool, owner) } });
function fixture() {
  const listeners = new Set<(event: WalletEvent) => void>();
  const wallet = { subscribe: vi.fn((listener: (event: WalletEvent) => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }) } as unknown as WalletPort;
  return { session: createKeySession(wallet, { scope, epoch: 1 }, location),
    emit: (event: WalletEvent) => { for (const listener of listeners) listener(event); }, listeners };
}

it('constructs the exact six UTF-8 lines without a trailing LF', () => {
  const bytes = recipientMessage(1n, pool.toUpperCase().replace('0X', '0x') as Address, owner);
  expect(new TextDecoder().decode(bytes)).toBe([
    'ECU Uniswap recipient-key reproducibility probe v1',
    'This signature is secret key material. Never share it.',
    'Purpose: ecu/uniswap/key-root/v1', 'ChainId: 1', `Pool: ${pool}`, `Owner: ${owner}`,
  ].join('\n'));
  expect(bytes.at(-1)).not.toBe(10);
  expect(() => recipientMessage(-1n, pool, owner)).toThrow();
  expect(() => recipientMessage(1n, '0x1234' as Address, owner)).toThrow();
});

it('matches independent Node HKDF and HPKE oracle and keeps AES key non-extractable', async () => {
  const signature = await sign();
  const salt = createHash('sha256').update('ecu/uniswap/key-root/hkdf-salt/v1').digest();
  const derive = (label: string) => new Uint8Array(hkdfSync('sha256', hexToBytes(signature), salt, label, 32));
  const ikm = derive('ecu/uniswap/recipient-ikm/v1');
  const record = derive('ecu/uniswap/operation-record-key/v1');
  expect(ikm.length).toBe(32); expect(record.length).toBe(32);
  expect(Buffer.from(ikm).equals(Buffer.from(record))).toBe(false);
  const oracle = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const pair = await oracle.kem.deriveKeyPair(ikm);
  const expected = new Uint8Array(await oracle.kem.serializePublicKey(pair.publicKey));
  expect(bytesToHex(expected)).toBe('0xb8564878dc0cfbe435003ac06f7cba93df33832241143c87978d511aa6d4b078');
  const { session } = fixture();
  await session.prepare(signature);
  expect(session.recipientPublicKey()).toEqual(expected);
  const privateCopy = session.recipientPrivateKeyForWorker();
  expect(privateCopy).toEqual(new Uint8Array(await oracle.kem.serializePrivateKey(pair.privateKey)));
  privateCopy.fill(0);
  expect(session.recipientPrivateKeyForWorker().some(byte => byte !== 0)).toBe(true);
  const key = session.recordKey();
  expect(key.extractable).toBe(false);
  expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
  await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  const iv = new Uint8Array(12);
  const plaintext = new TextEncoder().encode('synthetic operation');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const oracleKey = await crypto.subtle.importKey('raw', record, 'AES-GCM', false, ['decrypt']);
  expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, oracleKey, ciphertext))).toEqual(plaintext);
  await session.prepare(signature);
  expect(session.recipientPublicKey()).toEqual(expected);
  expect(session.recipientInfo()).toEqual({ chainId: 1n, pool, owner,
    receivePublicKey: bytesToHex(expected), receiptFormat: 1, recipientInfoVersion: 1 });
  expect(JSON.stringify(session)).toBe('{}');
});

it('rejects wrong owner/message, high-s, invalid r/s/v and malformed signatures without echoing material', async () => {
  const signature = await sign();
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const invalid = [
    await account.signMessage({ message: 'wrong message' }),
    await account.signMessage({ message: { raw: recipientMessage(2n, pool, owner) } }),
    await account.signMessage({ message: { raw: recipientMessage(1n, owner, owner) } }),
    await privateKeyToAccount(keccak256(stringToHex('other synthetic account'))).signMessage({ message: { raw: recipientMessage(1n, pool, owner) } }),
    `${signature.slice(0, 66)}${(order - s).toString(16).padStart(64, '0')}${signature.slice(130)}`,
    `${signature.slice(0, 130)}00`, `${signature.slice(0, 130)}1d`,
    `0x${'00'.repeat(32)}${signature.slice(66)}`,
    `0x${order.toString(16)}${signature.slice(66)}`,
    `${signature.slice(0, 66)}${'00'.repeat(32)}1b`, '0x1234',
  ];
  for (const value of invalid) {
    const { session } = fixture();
    await expect(session.prepare(value as `0x${string}`)).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(() => session.recordKey()).toThrow('NOT_PREPARED');
  }
});

it('denies all access on disposal or wallet scope/epoch advance, including an in-flight prepare', async () => {
  const signature = await sign();
  for (const change of ['dispose', 'epoch', 'owner', 'deployment', 'disconnect'] as const) {
    const { session, emit, listeners } = fixture();
    await session.prepare(signature);
    const pending = session.prepare(signature);
    if (change === 'dispose') session.dispose();
    else emit(change === 'disconnect' ? { epoch: 2 } : { epoch: change === 'epoch' ? 2 : 1,
      scope: { deploymentId: change === 'deployment' ? 'other' as DeploymentId : scope.deploymentId,
        owner: change === 'owner' ? pool : owner } });
    await expect(pending).rejects.toThrow('SESSION_DISPOSED');
    for (const access of [() => session.recordKey(), () => session.recipientPublicKey(),
      () => session.recipientPrivateKeyForWorker(), () => session.recipientInfo()]) expect(access).toThrow('SESSION_DISPOSED');
    await expect(session.prepare(signature)).rejects.toThrow('SESSION_DISPOSED');
    expect(listeners.size).toBe(0);
  }
});

it('never exposes an old key while a new prepare fails or supersedes another prepare', async () => {
  const { session } = fixture();
  const signature = await sign();
  await session.prepare(signature);
  const first = session.prepare(signature);
  const second = session.prepare(signature);
  await expect(first).rejects.toThrow('PREPARATION_SUPERSEDED');
  await second;
  await expect(session.prepare('0x00')).rejects.toThrow('INVALID_SIGNATURE');
  expect(() => session.recordKey()).toThrow('NOT_PREPARED');
});

it('sanitizes crypto failures without publishing secret-bearing error objects', async () => {
  const { session } = fixture();
  const signature = await sign();
  const failure = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error(signature));
  try {
    await expect(session.prepare(signature)).rejects.toMatchObject({ message: 'DERIVATION_FAILED' });
    expect(() => session.recordKey()).toThrow('NOT_PREPARED');
  } finally { failure.mockRestore(); }
});
