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

it('matches the merged AdapterAuthorizationTest payment digest vector', () => {
  const terms: PaymentTerms = {
    operationId: '0xd3f5da24e3f3ed38dc05a6fe1f8493e88897d930ca9599ce9eca92f17fab966e' as OperationId,
    owner: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1' as Address,
    ethAmount: 3n, token: `0x${'33'.repeat(20)}` as Address,
    minAmountOut: 2n, recipient: `0x${'44'.repeat(20)}` as Address,
    deadline: 1000n,
  };
  expect(paymentDigest(terms, 31337n, `0x${'22'.repeat(20)}` as Address)).toBe(
    '0x8b9a3f0c7fd79170cfe55065db21ec76966e79e251092c64f4dc6e702c3b40b6',
  );
});
