import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import { createEnvelope, messageFor, openEnvelope, recipientFromSignature } from './hpke-core.mjs';

globalThis.crypto ??= webcrypto;

test('same signature yields same key and independent recipient opens 112-byte v1 packet; tamper rejected', async () => {
  const wallet = Wallet.createRandom();
  const owner = wallet.address;
  const chainId = '11155111';
  const signature = await wallet.signMessage(messageFor(owner, chainId));
  const first = await recipientFromSignature(owner, chainId, signature);
  const second = await recipientFromSignature(owner, chainId, signature);
  assert.equal(first.publicKey, second.publicKey);
  const otherChainSignature = await wallet.signMessage(messageFor(owner, '1'));
  const otherChain = await recipientFromSignature(owner, '1', otherChainSignature);
  assert.notEqual(first.publicKey, otherChain.publicKey);
  await assert.rejects(recipientFromSignature(owner, '1', signature));
  const envelope = await createEnvelope(owner, chainId, first);
  assert.equal((envelope.packet.length - 2) / 2, 112);
  const result = await openEnvelope(envelope, owner, chainId, second);
  assert.equal(result.decryptedFormatAndRangeValid, true);
  assert.equal(result.tamperingRejected, true);
  await assert.rejects(openEnvelope({ ...envelope, chainId: '1' }, owner, chainId, second));
  await assert.rejects(openEnvelope(envelope, owner, '1', second));
  const lastByte = parseInt(envelope.packet.slice(-2), 16) ^ 1;
  await assert.rejects(openEnvelope({ ...envelope, packet: `${envelope.packet.slice(0, -2)}${lastByte.toString(16).padStart(2, '0')}` }, owner, chainId, second));
});
