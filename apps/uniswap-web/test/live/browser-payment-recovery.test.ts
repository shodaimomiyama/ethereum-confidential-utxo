import { expect, it, vi } from 'vitest';
import { createBrowserPaymentRecovery } from '../../src/live/browser-payment-recovery.js';
import { openPaymentPrivateRecord } from '../../src/live/payment-record.js';
import { createScopedEthereumBridge } from '../../src/live/ethereum.js';

vi.mock('../../src/live/payment-record.js', () => ({
  openPaymentPrivateRecord: vi.fn(), encodePaymentPrivateRecord: vi.fn(() => new Uint8Array([1])),
  createPaymentRecordEncryptor: vi.fn(() => vi.fn(async () => ({ ciphertext: 'AQID',
    nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` }))),
}));
vi.mock('../../src/live/ethereum.js', () => ({ createScopedEthereumBridge: vi.fn() }));
vi.mock('../../src/live/http.js', () => ({ createHttpClient: vi.fn(() => ({})),
  sameScope: (a: { deploymentId: string; owner: string }, b: { deploymentId: string; owner: string }) =>
    a.deploymentId === b.deploymentId && a.owner.toLowerCase() === b.owner.toLowerCase() }));
vi.mock('../../src/live/reservations.js', () => ({ createReservationPort: vi.fn(() => ({
  get: vi.fn(async () => saved), release: vi.fn(), list: vi.fn(), reserve: vi.fn(), update: vi.fn(),
})) }));

const id = (digit: string) => `0x${digit.repeat(64)}`;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const scope = { deploymentId: 'local-1', owner: addr('1') };
const point = { mode: 'local-simulated', number: 10n, hash: id('a') };
const record = { kind: 'pay', scope, recordId: id('1'), inputId: id('2'), operationId: id('3'),
  contentHash: id('4'), paymentId: id('5'), deadline: 100n, signatureStarted: true,
  attemptIds: ['attempt-1'], encryptedBundle: { ciphertext: 'AQID',
    nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` } };
const saved = { record, revision: 3, reservationState: 'active' };

function fixture() {
  const context = { scope, epoch: 1, check: vi.fn(), recordKey: () => ({} as CryptoKey) };
  const verified = { context: { chainId: 31337n, pool: addr('2'), finalityMode: 'local-simulated',
    deploymentBlock: 1n }, manifest: { chainId: 31337, pool: { address: addr('2') } } };
  const deployment = { chainId: 31337n, pool: addr('2'), adapter: addr('3'), token: addr('4'),
    router: addr('5'), factory: addr('6'), weth: addr('7'), pair: addr('8') };
  const browser = { deploymentId: scope.deploymentId, chainId: 31337n,
    pool: addr('2'), adapter: addr('3'), origin: 'https://localhost:5173',
    siweUri: 'https://localhost:5173/app' };
  const history = { getFinalizedCheckpoint: vi.fn(async () => point),
    getUtxo: vi.fn(async () => ({ complete: true, blockHash: point.hash,
      value: { exists: true, owner: scope.owner, consumedBy: null } })) };
  vi.mocked(createScopedEthereumBridge).mockReturnValue({ history } as never);
  const rpc = { mode: 'local-simulated', client: { getChainId: vi.fn(async () => 31337),
    getBlock: vi.fn(async () => ({ hash: point.hash, timestamp: 50n })),
    getTransactionReceipt: vi.fn(async () => { throw new Error('not found'); }) } };
  const plain = { version: 1, creationInputs: { operationId: record.operationId }, binding: record,
    intendedAuthorization: { pool: { operationId: record.operationId } }, attempts: [{ attemptId: 'attempt-1' }],
    recoveryMarkers: {}, quote: { startedAtMs: 0, blockHash: point.hash, blockNumber: 1n,
      inputWei: 1n, quoteOut: 2n } };
  vi.mocked(openPaymentPrivateRecord).mockResolvedValue(plain as never);
  const reconciliation = { expectedChainId: 31337n, readFinalized: vi.fn(async () => ({
    history: { finalized: true, canonical: true, checkpoint: point }, receipt: {} })) };
  const deps = { context, verified, deployment, browser, rpc, reconciliation,
    resolveVerified: () => verified, resolveDeployment: () => deployment };
  return { deps, history, rpc, reconciliation, plain };
}

it('keeps an attempt with no pinned transaction hash unknown', async () => {
  const f = fixture();
  const recovery = createBrowserPaymentRecovery(f.deps as never);
  const result = await recovery.readEvidence(saved as never);
  expect(result.evidence.attempts).toEqual([{ id: 'attempt-1', outcome: 'unknown' }]);
  expect(result.evidence.submissionKnownAbsent).toBe(false);
  expect(result.currentInput.state).toBe('unspent');
});

it('fails closed when the finalized checkpoint does not match the RPC chain', async () => {
  const f = fixture();
  f.rpc.client.getBlock.mockResolvedValue({ hash: id('b'), timestamp: 50n });
  const recovery = createBrowserPaymentRecovery(f.deps as never);
  await expect(recovery.readEvidence(saved as never)).rejects.toThrow('PAYMENT_CHECKPOINT_REORG');
});

it('restores the original quote and authorization from the encrypted saved record', async () => {
  const f = fixture();
  const recovery = createBrowserPaymentRecovery(f.deps as never);
  const restored = await recovery.restoreOriginal(saved as never, {} as never);
  expect(restored.prepared.record).toEqual(record);
  expect(restored.prepared.poolAuthorization).toEqual(f.plain.intendedAuthorization.pool);
  expect('quote' in restored.prepared && restored.prepared.quote).toEqual(f.plain.quote);
  expect(restored.signatures).toBeUndefined();
  vi.mocked(openPaymentPrivateRecord).mockResolvedValue({ ...f.plain, quote: undefined } as never);
  await expect(recovery.restoreOriginal(saved as never, {} as never)).rejects.toThrow('PAYMENT_RECOVERY_BLOCKED');
});
