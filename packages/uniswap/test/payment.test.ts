import { expect, it } from 'vitest';
import { assertWithdrawalBinding, paymentDigest } from '../src/payment.js';
import type { PaymentTerms } from '../src/payment.js';
import type { Address, InputId, OperationId } from '../src/domain.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const operationId = `0x${'11'.repeat(32)}` as OperationId;
const inputId = `0x${'66'.repeat(32)}` as InputId;
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
  ]) expect(() => paymentDigest(bad, 31337n, adapter)).toThrow();
});

it('rejects withdrawal mismatch and forbidden recipients', () => {
  const withdrawal = {
    kind: 2, owner, d: 0n, w: terms.ethAmount, destination: adapter,
    inputIds: [inputId], outputs: [{ owner }],
  };
  const deployment = { adapter, token, pool: address('6'), router: address('7'), factory: address('8'), weth: address('9'), pair: address('a') };
  const computeId = () => operationId;
  expect(() => assertWithdrawalBinding(withdrawal, terms, deployment, computeId, 1)).not.toThrow();
  expect(() => assertWithdrawalBinding({ ...withdrawal, destination: owner }, terms, deployment, computeId, 1)).toThrow();
  expect(() => assertWithdrawalBinding(withdrawal, { ...terms, recipient: adapter }, deployment, computeId, 1)).toThrow();
  expect(() => assertWithdrawalBinding(withdrawal, terms, deployment, () => `0x${'99'.repeat(32)}` as OperationId, 1)).toThrow();
  expect(() => assertWithdrawalBinding(withdrawal, terms, deployment, computeId, 0)).toThrow();
});
