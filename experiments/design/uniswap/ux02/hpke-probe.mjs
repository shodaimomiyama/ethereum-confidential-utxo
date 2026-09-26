import { createEnvelope, messageFor, openEnvelope, recipientFromSignature } from './hpke-core.mjs';

const output = document.querySelector('#result');
const envelopeInput = document.querySelector('#envelope');
const makeButton = document.querySelector('#make');
const openButton = document.querySelector('#open');

async function sign() {
  if (!window.ethereum?.request) throw new Error('MetaMask provider unavailable');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) throw new Error('No EOA selected');
  const owner = accounts[0].toLowerCase();
  const chainId = BigInt(await window.ethereum.request({ method: 'eth_chainId' })).toString(10);
  const message = messageFor(owner, chainId);
  const bytes = new TextEncoder().encode(message);
  const hex = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, owner] });
  return { owner, chainId, signature };
}

async function run(action) {
  makeButton.disabled = openButton.disabled = true;
  output.textContent = 'Waiting for MetaMask and local cryptography…';
  try {
    await action();
  } catch (error) {
    // Library exceptions can contain sensitive input. Report only an error class.
    output.textContent = `No result. Error class: ${String(error?.name ?? 'Error')}`;
  } finally {
    makeButton.disabled = openButton.disabled = false;
  }
}

makeButton.addEventListener('click', () => run(async () => {
  const { owner, chainId, signature } = await sign();
  const recipient = await recipientFromSignature(owner, chainId, signature);
  const envelope = await createEnvelope(owner, chainId, recipient);
  envelopeInput.value = JSON.stringify(envelope, null, 2);
  output.textContent = JSON.stringify({ role: 'profile A', owner, chainId, recipientPublicKey: recipient.publicKey, publicEnvelopeReady: true, packetBytes: 112, privateDataExported: false }, null, 2);
}));

openButton.addEventListener('click', () => run(async () => {
  if (envelopeInput.value.length > 4096) throw new Error('Oversized public envelope');
  const envelope = JSON.parse(envelopeInput.value);
  const { owner, chainId, signature } = await sign();
  const recipient = await recipientFromSignature(owner, chainId, signature);
  const result = await openEnvelope(envelope, owner, chainId, recipient);
  output.textContent = JSON.stringify({ role: 'profile B', owner, chainId, ...result }, null, 2);
}));
