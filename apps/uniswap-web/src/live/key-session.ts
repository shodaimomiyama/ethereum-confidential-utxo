import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { bytesToHex, hexToBytes, recoverMessageAddress } from 'viem';
import type { Address, Scope } from '@confidential-utxo/uniswap';
import type { DeploymentLocation } from './scope.js';
import type { WalletPort } from './wallet.js';

export type HexSignature = `0x${string}`;

// The canonical core typed-data builder must sign these fields at integration time.
export interface UnsignedRecipientInfo {
  readonly chainId: bigint;
  readonly pool: Address;
  readonly owner: Address;
  readonly receivePublicKey: `0x${string}`;
  readonly receiptFormat: 1;
  readonly recipientInfoVersion: 1;
}

export interface KeySession {
  prepare(signatureHex: HexSignature): Promise<void>;
  recipientPublicKey(): Uint8Array<ArrayBuffer>;
  recipientInfo(): UnsignedRecipientInfo;
  /** Internal operation-record crypto adapter only; never include in UI state. */
  recordKey(): CryptoKey;
  /** Caller transfers this fresh copy to one receipt job and clears it after use. */
  recipientPrivateKeyForWorker(): Uint8Array<ArrayBuffer>;
  dispose(): void;
}

export type KeySessionErrorCode = 'INVALID_SCOPE' | 'INVALID_SIGNATURE' | 'NOT_PREPARED'
  | 'SESSION_DISPOSED' | 'PREPARATION_SUPERSEDED' | 'DERIVATION_FAILED';

export class KeySessionError extends Error {
  constructor(readonly code: KeySessionErrorCode) {
    super(code);
    this.name = 'KeySessionError';
  }
}

const encoder = new TextEncoder();
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const kem = new DhkemX25519HkdfSha256();

function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new KeySessionError('INVALID_SCOPE');
  return value.toLowerCase() as Address;
}

export function recipientMessage(chainId: bigint, pool: Address, owner: Address): Uint8Array<ArrayBuffer> {
  if (chainId <= 0n) throw new KeySessionError('INVALID_SCOPE');
  return encoder.encode([
    'ECU Uniswap recipient-key reproducibility probe v1',
    'This signature is secret key material. Never share it.',
    'Purpose: ecu/uniswap/key-root/v1',
    `ChainId: ${chainId}`, `Pool: ${address(pool)}`, `Owner: ${address(owner)}`,
  ].join('\n'));
}

function canonicalSignature(signature: HexSignature): Uint8Array<ArrayBuffer> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new KeySessionError('INVALID_SIGNATURE');
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  if (r < 1n || r >= order || s < 1n || s > order / 2n || (v !== 27 && v !== 28)) {
    throw new KeySessionError('INVALID_SIGNATURE');
  }
  return new Uint8Array(hexToBytes(signature));
}

export function createKeySession(
  wallet: Pick<WalletPort, 'subscribe'>,
  connection: { readonly scope: Scope; readonly epoch: number },
  location: DeploymentLocation,
): KeySession {
  const owner = address(connection.scope.owner);
  const pool = address(location.pool);
  const chainId = location.chainId;
  const deploymentId = connection.scope.deploymentId;
  const epoch = connection.epoch;
  const message = recipientMessage(chainId, pool, owner);
  let disposed = false;
  let generation = 0;
  let publicKey: Uint8Array<ArrayBuffer> | undefined;
  let privateKey: Uint8Array<ArrayBuffer> | undefined;
  let recordKey: CryptoKey | undefined;
  const clear = (): void => {
    privateKey?.fill(0);
    privateKey = undefined;
    publicKey = undefined;
    recordKey = undefined;
  };
  const check = (expected?: number): void => {
    if (disposed) throw new KeySessionError('SESSION_DISPOSED');
    if (expected !== undefined && expected !== generation) throw new KeySessionError('PREPARATION_SUPERSEDED');
  };
  const ready = (): void => {
    check();
    if (!publicKey || !privateKey || !recordKey) throw new KeySessionError('NOT_PREPARED');
  };
  let unsubscribe = (): void => {};
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation++;
    clear();
    unsubscribe();
  };
  unsubscribe = wallet.subscribe(event => {
    if (event.epoch !== epoch || event.scope?.deploymentId !== deploymentId
      || event.scope.owner.toLowerCase() !== owner) dispose();
  });
  if (disposed) unsubscribe();

  return {
    async prepare(signatureHex) {
      check();
      const current = ++generation;
      clear();
      let signatureBytes: Uint8Array<ArrayBuffer> | undefined;
      let recipientIkm: Uint8Array<ArrayBuffer> | undefined;
      let recordBytes: Uint8Array<ArrayBuffer> | undefined;
      let recipientPrivate: Uint8Array<ArrayBuffer> | undefined;
      try {
        signatureBytes = canonicalSignature(signatureHex);
        let recovered: string;
        try { recovered = await recoverMessageAddress({ message: { raw: message }, signature: signatureHex }); }
        catch { throw new KeySessionError('INVALID_SIGNATURE'); }
        signatureHex = '0x';
        check(current);
        if (recovered.toLowerCase() !== owner) throw new KeySessionError('INVALID_SIGNATURE');
        const salt = await crypto.subtle.digest('SHA-256', encoder.encode('ecu/uniswap/key-root/hkdf-salt/v1'));
        const baseKey = await crypto.subtle.importKey('raw', signatureBytes, 'HKDF', false, ['deriveBits']);
        signatureBytes.fill(0);
        signatureBytes = undefined;
        const derive = async (info: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(
          await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, baseKey, 256),
        );
        recipientIkm = await derive('ecu/uniswap/recipient-ikm/v1');
        recordBytes = await derive('ecu/uniswap/operation-record-key/v1');
        check(current);
        const pair = await kem.deriveKeyPair(recipientIkm);
        recipientIkm.fill(0);
        recipientIkm = undefined;
        const recipientPublic = new Uint8Array(await kem.serializePublicKey(pair.publicKey));
        recipientPrivate = new Uint8Array(await kem.serializePrivateKey(pair.privateKey));
        const importedRecord = await crypto.subtle.importKey('raw', recordBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
        check(current);
        publicKey = recipientPublic;
        privateKey = recipientPrivate;
        recipientPrivate = undefined;
        recordKey = importedRecord;
      } catch (error) {
        check(current);
        if (error instanceof KeySessionError) throw error;
        throw new KeySessionError('DERIVATION_FAILED');
      } finally {
        signatureHex = '0x';
        signatureBytes?.fill(0);
        recipientIkm?.fill(0);
        recordBytes?.fill(0);
        recipientPrivate?.fill(0);
      }
    },
    recipientPublicKey() { ready(); return publicKey!.slice(); },
    recipientInfo() {
      ready();
      return { chainId, pool, owner, receivePublicKey: bytesToHex(publicKey!), receiptFormat: 1, recipientInfoVersion: 1 };
    },
    recordKey() { ready(); return recordKey!; },
    recipientPrivateKeyForWorker() { ready(); return privateKey!.slice(); },
    dispose,
  };
}
