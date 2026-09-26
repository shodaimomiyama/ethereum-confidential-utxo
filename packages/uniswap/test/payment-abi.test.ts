import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeErrorResult } from 'viem';
import type { LocalDraft, OperationRequest } from '@confidential-utxo/core';
import { expect, it } from 'vitest';
import { adapterAbi } from '../src/generated/adapter-abi.js';
import { decodeAdapterError, encodePayCall } from '../src/payment.js';
import type { PaymentDeployment, PaymentTerms } from '../src/payment.js';

const vectors = JSON.parse(readFileSync(new URL('../../../tests/vectors/cases/uniswap-payment-operations.json', import.meta.url), 'utf8')) as
  { id: string; input: Record<string, unknown>; expected: { operationId: string } }[];
const vector = vectors.find((item) => item.id === 'VEC-07-POOL-WITHDRAW-PAY');
if (vector === undefined) throw new Error('missing Pool payment vector');
const input = vector.input;
const output = (input.outputs as { owner: string; Cx: string; Cy: string; receiptFormat: 1; packet: string }[])[0]!;
const request = {
  kind: 2, owner: input.owner, salt: input.salt, inputIds: input.inputIds,
  outputs: [{ owner: output.owner, commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) }, receiptFormat: 1, packet: output.packet }],
  d: 0n, w: BigInt(input.w as string), destination: input.destination,
} as OperationRequest;
const draft = {
  context: {
    chainId: BigInt(input.chainId as string), pool: input.pool,
    deploymentBlock: 1n, verifier: `0x${'99'.repeat(20)}`,
    parametersHash: `0x${'00'.repeat(32)}`, finalityMode: 'local-simulated',
  },
  request, operationId: vector.expected.operationId,
  balanceProof: { Rx: 1n, Ry: 2n, s: 3n },
  rangeProofs: [{ coords: Array(10).fill(0n), scalars: Array(5).fill(0n), ls: [], rs: [] }],
} as unknown as LocalDraft;
const terms: PaymentTerms = {
  operationId: vector.expected.operationId as never, owner: request.owner as never,
  ethAmount: request.w, token: `0x${'33'.repeat(20)}` as never,
  minAmountOut: 1n, recipient: `0x${'44'.repeat(20)}` as never, deadline: 600n,
};
const deployment: PaymentDeployment = {
  adapter: request.destination as never, token: terms.token,
  pool: draft.context.pool as never, router: `0x${'77'.repeat(20)}` as never,
  factory: `0x${'88'.repeat(20)}` as never, weth: `0x${'aa'.repeat(20)}` as never,
  pair: `0x${'bb'.repeat(20)}` as never,
};
const poolSignature = `0x${'11'.repeat(65)}` as const;
const paymentSignature = `0x${'22'.repeat(65)}` as const;

it('encodes the core withdrawal and payment terms through the generated Adapter ABI', () => {
  const data = encodePayCall(draft, terms, deployment, poolSignature, paymentSignature);
  const artifact = JSON.parse(readFileSync(new URL('../../../packages/ethereum/generated/uniswap-payment-v1.json', import.meta.url), 'utf8')) as
    { methodIdentifiers: Record<string, string> };
  const selector = Object.entries(artifact.methodIdentifiers).find(([name]) => name.startsWith('pay('))?.[1];
  expect(data.slice(2, 10)).toBe(selector);
  const decoded = decodeFunctionData({ abi: adapterAbi, data });
  expect(decoded.functionName).toBe('pay');
  if (decoded.functionName !== 'pay') throw new Error('wrong function');
  const [withdrawal, , rangeProofs, encodedPoolSignature, encodedTerms, encodedPaymentSignature] = decoded.args;
  expect(withdrawal.inputIds).toEqual(request.inputIds);
  expect(withdrawal.outputs[0]?.Cx).toBe(output.Cx === undefined ? undefined : BigInt(output.Cx));
  expect(rangeProofs).toHaveLength(1);
  expect(encodedPoolSignature).toBe(poolSignature);
  expect(encodedTerms.deadline).toBe(600n);
  expect(encodedPaymentSignature).toBe(paymentSignature);
});

it('rejects malformed fixed-size range proof arrays before ABI encoding', () => {
  const malformed = { ...draft, rangeProofs: [{ ...draft.rangeProofs[0]!, coords: [0n] }] } as LocalDraft;
  expect(() => encodePayCall(malformed, terms, deployment, poolSignature, paymentSignature)).toThrow('INVALID_FIELD');
});

it('identifies Adapter errors only when a trace proves the originating frame', () => {
  const data = encodeErrorResult({ abi: adapterAbi, errorName: 'PaymentExpired', args: [600n] });
  expect(decodeAdapterError(data, 'trace-proven-adapter')).toEqual({ kind: 'adapter', name: 'PaymentExpired' });
  expect(decodeAdapterError(data, 'unverified')).toEqual({ kind: 'unknown' });
  expect(decodeAdapterError('0x12345678', 'trace-proven-adapter')).toEqual({ kind: 'unknown' });
});
