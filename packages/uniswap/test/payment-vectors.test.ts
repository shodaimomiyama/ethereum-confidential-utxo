import { expect, it } from 'vitest';
import { paymentDigest } from '../src/payment.js';
import type { PaymentTerms } from '../src/payment.js';
import type { Address, OperationId } from '../src/domain.js';

it('matches the independent Solidity PaymentVectorTest digest', () => {
  const terms: PaymentTerms = {
    operationId: `0x${'11'.repeat(32)}` as OperationId,
    owner: `0x${'22'.repeat(20)}` as Address,
    ethAmount: 1_000_000_000_000_000_000n,
    token: `0x${'33'.repeat(20)}` as Address,
    minAmountOut: 99n,
    recipient: `0x${'44'.repeat(20)}` as Address,
    deadline: 600n,
  };
  const adapter = `0x${'55'.repeat(20)}` as Address;
  expect(paymentDigest(terms, 31337n, adapter)).toBe(
    '0x65b68bd6858a7947aef50aa010ad17946ee527a79ebc0d7185603fbfe70f157c',
  );
});
