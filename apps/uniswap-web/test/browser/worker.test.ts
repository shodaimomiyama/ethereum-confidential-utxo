import { expect, it } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import type { CryptoWorkerClient } from '../../src/live/worker-client.js';
import rangeVectors from '../../../../tests/vectors/cases/range-deterministic.json' with { type: 'json' };
import balanceVectors from '../../../../tests/vectors/cases/balance.json' with { type: 'json' };
import hpkeVectors from '../../../../tests/vectors/cases/hpke.json' with { type: 'json' };
import applicationVectors from '../../../../tests/vectors/cases/application-operation.json' with { type: 'json' };
const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.slice(2).match(/../g)!, x => parseInt(x, 16));
const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
async function client(): Promise<CryptoWorkerClient> {
  const path = '/worker-bundle/worker-client.js';
  const bundle: typeof import('../../src/live/worker-client.js') = await import(/* @vite-ignore */ path);
  return new bundle.CryptoWorkerClient();
}
it('imports the public crypto entry point with no Node Buffer', async () => {
  expect('Buffer' in globalThis).toBe(false);
  const core = await import('@confidential-utxo/crypto');
  expect(core.commit({ amount: 1n, blinding: 0n }).x).toBeGreaterThan(0n);
});
it('runs the production Worker bundle with range/balance vector inputs and secure randomness', async () => {
  const worker = await client();
  const range = rangeVectors[0]!.input;
  const balance = balanceVectors[0]!;
  const { balanceWitness } = await import('@confidential-utxo/crypto');
  const started = performance.now();
  try {
    const result = await worker.run({ kind: 'prove', jobId: 'proof', epoch: 0, scope, payload: {
      range: [{ amount: BigInt(range.amount), blinding: BigInt(range.blinding) }, bytes(range.operationId), BigInt(range.outputIndex)],
      balance: { X: { x: BigInt(balance.expected.X![0]!), y: BigInt(balance.expected.X![1]!) },
        x: balanceWitness([], balance.input.outputOpenings!.map(opening => BigInt(opening.blinding))), chainId: BigInt(balance.input.chainId!), pool: bytes(balance.input.pool!), operationId: bytes(balance.input.operationId!) },
    } });
    expect(result.jobKind).toBe('prove');
    if (result.jobKind !== 'prove') throw new Error('wrong result kind');
    expect(result.value.range.coords.slice(0, 2)).toEqual(range.coords.slice(0, 2).map(BigInt));
    expect(result.value.range.coords).toHaveLength(10); expect(result.value.range.scalars).toHaveLength(5);
    expect(result.value.range.ls).toHaveLength(12); expect(result.value.range.rs).toHaveLength(12);
    expect(result.value.balance.Rx).toBeTypeOf('bigint'); expect(result.value.balance.s).toBeGreaterThan(0n);
    expect(Object.keys(result).sort()).toEqual(['epoch', 'jobId', 'jobKind', 'kind', 'scope', 'value']);
    console.info(`Worker proof elapsed: ${(performance.now() - started).toFixed(0)} ms; ${navigator.userAgent}`);
  } finally { worker.dispose(); }
});
it('decrypts a known HPKE vector and returns only the opening; tampering returns a sanitized error', async () => {
  const worker = await client(); const vector = hpkeVectors.find(v => v.id === 'VEC-07-RECEIPT-VALID')!.input;
  const payload = { recipientPrivateKey: bytes(vector.recipientPrivateKey!), info: bytes(vector.info), packet: bytes(vector.packet!),
    commitment: { x: BigInt(vector.Cx!), y: BigInt(vector.Cy!) } };
  try {
    const result = await worker.run({ kind: 'receive', jobId: 'receipt', epoch: 0, scope, payload });
    expect(result).toEqual({ kind: 'result', jobKind: 'receive', jobId: 'receipt', epoch: 0, scope, value: { amount: 1n, blinding: 0n } });
    payload.packet[45] = payload.packet[45]! ^ 1;
    await expect(worker.run({ kind: 'receive', jobId: 'bad', epoch: 0, scope, payload })).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  } finally { payload.recipientPrivateKey.fill(0); worker.dispose(); }
});

it('builds a full Withdraw through published core in the production Worker and verifies its balance proof', async () => {
  const { operationId, validateOperationShape } = await import('@confidential-utxo/core');
  const { commit, computeBalancePoint } = await import('@confidential-utxo/crypto');
  const { balanceChallengeTrace } = await import('../../../../packages/crypto/src/balance.js');
  const { G } = await import('../../../../packages/crypto/src/fixed-parameters.js');
  const { add, mul, samePoint } = await import('../../../../packages/crypto/src/group.js');
  const payload = withdrawPayload();
  payload.inputs.forEach(input => { input.commitment = commit(input.opening); });
  const before = structuredClone(payload);
  const worker = await client();
  try {
    const result = await worker.run({ kind: 'build-operation', jobId: 'withdraw', epoch: 0, scope, payload });
    const draft = result.value;
    expect(result.jobKind).toBe('build-operation');
    expect(draft.context).toEqual(payload.context);
    expect(draft.request).toMatchObject({ kind: 2, owner: scope.owner, inputIds: payload.inputs.map(i => i.id).reverse(),
      outputs: [], d: 0n, w: 12n, destination: payload.intent.destination });
    expect(() => validateOperationShape(draft.request)).not.toThrow();
    expect(draft.operationId).toBe(operationId(payload.context, draft.request));
    expect(draft.outputIds).toEqual([]); expect(draft.openings).toEqual([]); expect(draft.rangeProofs).toEqual([]);
    expect(draft.inputOpenings).toEqual(payload.inputs.map(i => i.opening).reverse());
    expect(draft.signature).toBeUndefined();
    const X = computeBalancePoint(payload.inputs.map(i => i.commitment), [], 0n, 12n);
    const R = { x: draft.balanceProof.Rx, y: draft.balanceProof.Ry };
    const challenge = balanceChallengeTrace(payload.context.chainId, bytes(payload.context.pool), bytes(draft.operationId), X, R).at(-1)!.candidate;
    expect(samePoint(mul(G, draft.balanceProof.s), add(R, mul(X, challenge)))).toBe(true);
    const second = await worker.run({ kind: 'build-operation', jobId: 'fresh', epoch: 0, scope, payload });
    expect(second.value.request.salt).not.toBe(draft.request.salt);
    expect(second.value.operationId).not.toBe(draft.operationId);
    expect(payload).toEqual(before);
  } finally { worker.dispose(); }
});

it('builds a Deposit and encrypts a receivable output through published core in the production Worker', async () => {
  const vector = applicationVectors.find(v => v.id === 'VEC-07-APPLICATION-DEPOSIT')!;
  const receipt = vector.expected.receipts[0]!;
  const { commit, computeBalancePoint } = await import('@confidential-utxo/crypto');
  const { balanceChallengeTrace } = await import('../../../../packages/crypto/src/balance.js');
  const { G } = await import('../../../../packages/crypto/src/fixed-parameters.js');
  const { add, mul, samePoint } = await import('../../../../packages/crypto/src/group.js');
  const { operationId, outputId, receiptInfo, validateOperationShape } = await import('@confidential-utxo/core');
  const context: import('@confidential-utxo/core').Context = {
    chainId: BigInt(vector.input.chainId), pool: vector.input.pool as `0x${string}`, deploymentBlock: 1n,
    verifier: vector.input.pool as `0x${string}`, parametersHash: `0x${'00'.repeat(32)}`, finalityMode: 'finalized',
  };
  const recipient: import('@confidential-utxo/core').RecipientInfo = {
    chainId: context.chainId, pool: context.pool, owner: receipt.recipientInfo.owner as `0x${string}`,
    receivePublicKey: receipt.recipientInfo.receivePublicKey as `0x${string}`,
    receiptFormat: 1, recipientInfoVersion: 1, signature: receipt.recipientInfo.signature as `0x${string}`,
  };
  const payload: import('../../src/live/worker-protocol.js').CryptoPayloads['build-operation'] = {
    intent: { kind: 0, owner: vector.input.owner as `0x${string}`, amount: BigInt(vector.input.d),
      recipient }, context, inputs: [],
  };
  const worker = await client();
  const recipientPrivateKey = bytes(receipt.recipientPrivateKey);
  try {
    const result = await worker.run({ kind: 'build-operation', jobId: 'deposit', epoch: 0, scope, payload });
    const draft = result.value;
    const output = draft.request.outputs[0]!;
    expect(result.jobKind).toBe('build-operation');
    expect(draft.request).toMatchObject({ kind: 0, owner: payload.intent.owner, inputIds: [], d: 1n, w: 0n,
      outputs: [{ owner: receipt.expectedOwner, receiptFormat: 1 }] });
    expect(() => validateOperationShape(draft.request)).not.toThrow();
    expect(draft.operationId).toBe(operationId(context, draft.request));
    expect(draft.outputIds).toEqual([outputId(draft.operationId, 0)]);
    expect(draft.request.outputs).toHaveLength(1);
    expect(draft.openings).toHaveLength(1);
    expect(draft.openings[0]!.amount).toBe(payload.intent.amount);
    expect(output.commitment).toEqual(commit(draft.openings[0]!));
    expect(output.packet).toMatch(/^0x[0-9a-f]{224}$/);
    expect(output.packet).not.toBe(receipt.packet);
    expect(draft.inputOpenings).toEqual([]);
    expect(draft.rangeProofs).toEqual([]);
    expect(draft.signature).toBeUndefined();
    const X = computeBalancePoint([], [output.commitment], draft.request.d, draft.request.w);
    const R = { x: draft.balanceProof.Rx, y: draft.balanceProof.Ry };
    const challenge = balanceChallengeTrace(context.chainId, bytes(context.pool), bytes(draft.operationId), X, R).at(-1)!.candidate;
    expect(samePoint(mul(G, draft.balanceProof.s), add(R, mul(X, challenge)))).toBe(true);

    const received = await worker.run({ kind: 'receive', jobId: 'deposit-receipt', epoch: 0, scope,
      payload: { recipientPrivateKey, info: bytes(receiptInfo(context, draft.request, 0)),
        packet: bytes(output.packet), commitment: output.commitment } });
    expect(received.value).toEqual(draft.openings[0]);
    const wrongInfo = bytes(receiptInfo(context, draft.request, 0));
    wrongInfo[0] = wrongInfo[0]! ^ 1;
    await expect(worker.run({ kind: 'receive', jobId: 'deposit-wrong-info', epoch: 0, scope,
      payload: { recipientPrivateKey, info: wrongInfo, packet: bytes(output.packet), commitment: output.commitment } }))
      .rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  } finally { recipientPrivateKey.fill(0); worker.dispose(); }
});

function withdrawPayload() {
  const context: import('@confidential-utxo/core').Context = {
    chainId: 31337n, pool: `0x${'33'.repeat(20)}`, deploymentBlock: 0n, verifier: `0x${'44'.repeat(20)}`,
    parametersHash: `0x${'55'.repeat(32)}`, finalityMode: 'local-simulated',
  };
  const intent = { kind: 2 as const, owner: scope.owner, amount: 12n, destination: scope.owner };
  const inputs: import('@confidential-utxo/core').OwnedUtxo[] = [2, 1].map(id => ({
    id: `0x${id.toString(16).padStart(64, '0')}`, owner: scope.owner, opening: { amount: 6n, blinding: BigInt(id) },
    commitment: { x: 0n, y: 0n }, checkpoint: { number: 1n, hash: `0x${'66'.repeat(32)}`, mode: 'local-simulated' },
    status: 'available', chainId: context.chainId, pool: context.pool,
  }));
  return { intent, context, inputs };
}

it('sanitizes a rejected core build without returning private inputs', async () => {
  const worker = await client();
  try {
    await expect(worker.run({ kind: 'build-operation', jobId: 'invalid-build', epoch: 0, scope, payload: withdrawPayload() }))
      .rejects.toMatchObject({ code: 'CRYPTO_FAILED', message: 'CRYPTO_FAILED' });
  } finally { worker.dispose(); }
});

it('cancels a core build across A to B to A and delivers only the new epoch', async () => {
  const worker = await client();
  const { commit } = await import('@confidential-utxo/crypto');
  const payload = withdrawPayload(); payload.inputs.forEach(input => { input.commitment = commit(input.opening); });
  try {
    const old = worker.run({ kind: 'build-operation', jobId: 'same', epoch: 0, scope, payload });
    const cancelled = expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
    worker.setContext({ ...scope, owner: `0x${'22'.repeat(20)}` as Scope['owner'] }, 1); worker.setContext(scope, 2);
    await cancelled;
    const current = await worker.run({ kind: 'build-operation', jobId: 'same', epoch: 2, scope, payload });
    expect(current.epoch).toBe(2); expect(current.value.request.w).toBe(12n);
    const next = worker.run({ kind: 'build-operation', jobId: 'cancel', epoch: 2, scope, payload });
    const rejection = expect(next).rejects.toMatchObject({ code: 'CANCELLED' }); worker.cancel(); await rejection;
  } finally { worker.dispose(); }
});
