import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { operationId as coreOperationId } from '@confidential-utxo/core';
import type { OperationRequest } from '@confidential-utxo/core';
import { assertWithdrawalBinding, paymentAuthorizationTypedData, paymentDigest } from '../src/payment.js';
import type { WithdrawalBindingInput } from '../src/payment.js';
import type { PaymentTerms } from '../src/payment.js';
import type { Address, OperationId } from '../src/domain.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const operationId = `0x${'11'.repeat(32)}` as OperationId;
const owner = address('2');
const token = address('3');
const recipient = address('4');
const adapter = address('5');
const terms: PaymentTerms = {
  operationId, owner, ethAmount: 1_000_000_000_000_000_000n,
  token, minAmountOut: 99n, recipient, deadline: 600n,
};

it('binds every term and the deployment domain into the payment ID', () => {
  const original = paymentDigest(terms, 31337n, adapter);
  const changes: PaymentTerms[] = [
    { ...terms, operationId: `0x${'12'.repeat(32)}` as OperationId },
    { ...terms, owner: address('6') },
    { ...terms, ethAmount: 2n },
    { ...terms, token: address('6') },
    { ...terms, minAmountOut: 100n },
    { ...terms, recipient: address('6') },
    { ...terms, deadline: 601n },
  ];
  for (const changed of changes) expect(paymentDigest(changed, 31337n, adapter)).not.toBe(original);
  expect(paymentDigest(terms, 31338n, adapter)).not.toBe(original);
  expect(paymentDigest(terms, 31337n, address('6'))).not.toBe(original);
});

it('rejects invalid term ranges before hashing', () => {
  for (const bad of [
    { ...terms, minAmountOut: 0n },
    { ...terms, minAmountOut: 1n << 256n },
    { ...terms, deadline: 0n },
    { ...terms, deadline: 1n << 64n },
  ]) {
    expect(() => paymentDigest(bad, 31337n, adapter)).toThrow();
    expect(() => paymentAuthorizationTypedData(bad, 31337n, adapter)).toThrow();
  }
  expect(() => paymentAuthorizationTypedData(terms, 0n, adapter)).toThrow();
  expect(() => paymentAuthorizationTypedData(terms, 31337n, address('0'))).toThrow();
});

it('rejects withdrawal mismatch and forbidden recipients', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../tests/vectors/cases/operation.json', import.meta.url), 'utf8')) as
    { id: string; input: Record<string, unknown> }[];
  const source = vectors.find((vector) => vector.id === 'VEC-01-WITHDRAW-PARTIAL')?.input;
  if (source === undefined) throw new Error('missing core vector');
  const output = (source.outputs as { owner: string; Cx: string; Cy: string; receiptFormat: 1; packet: string }[])[0]!;
  const context = {
    chainId: 31337n, pool: source.pool as Address,
    deploymentBlock: 1n, verifier: address('a'), parametersHash: `0x${'00'.repeat(32)}`,
    finalityMode: 'local-simulated' as const,
  };
  const request = {
    kind: 2 as const, owner: source.owner as Address, salt: source.salt,
    inputIds: [(source.inputIds as string[])[0]],
    outputs: [{ owner: output.owner, commitment: { x: BigInt(output.Cx), y: BigInt(output.Cy) }, receiptFormat: 1, packet: output.packet }],
    d: 0n, w: 1n, destination: source.destination,
  } as OperationRequest;
  const id = coreOperationId(context as never, request) as OperationId;
  const withdrawal: WithdrawalBindingInput = { context: context as never, request, operationId: id, rangeProofs: [{}] as never };
  const paymentTerms: PaymentTerms = { ...terms, operationId: id, owner: request.owner as Address, ethAmount: 1n };
  const deployment = { adapter: request.destination as Address, token, pool: context.pool, router: address('7'), factory: address('8'), weth: address('9'), pair: address('b') };
  expect(() => assertWithdrawalBinding(withdrawal, paymentTerms, deployment)).not.toThrow();
  expect(() => assertWithdrawalBinding({ ...withdrawal, request: { ...request, destination: owner } }, paymentTerms, deployment)).toThrow();
  expect(() => assertWithdrawalBinding(withdrawal, { ...paymentTerms, recipient: deployment.adapter }, deployment)).toThrow();
  expect(() => assertWithdrawalBinding({ ...withdrawal, request: { ...request, salt: `0x${'99'.repeat(32)}` } }, paymentTerms, deployment)).toThrow();
  expect(() => assertWithdrawalBinding({ ...withdrawal, rangeProofs: [] }, paymentTerms, deployment)).toThrow();
});
