import { expect, it } from 'vitest';
import { concat, hashDomain, hashStruct, hashTypedData, keccak256 } from 'viem';
import { paymentAuthorizationTypedData, paymentDigest } from '../src/payment.js';
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
  const typed = paymentAuthorizationTypedData(terms, 31337n, adapter);
  expect(typed.domain).toEqual({
    name: 'Ethereum Confidential UTXO Uniswap Payment',
    version: '1', chainId: 31337n, verifyingContract: adapter,
  });
  expect(typed.primaryType).toBe('PaymentAuthorization');
  expect(typed.types.EIP712Domain).toEqual([
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]);
  expect(typed.types.PaymentAuthorization).toEqual([
    { name: 'operationId', type: 'bytes32' },
    { name: 'owner', type: 'address' },
    { name: 'ethAmount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'deadline', type: 'uint64' },
  ]);
  expect(typed.message).toEqual(terms);
  expect(hashTypedData(typed)).toBe('0x65b68bd6858a7947aef50aa010ad17946ee527a79ebc0d7185603fbfe70f157c');
  const rpc = JSON.parse(JSON.stringify(typed, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)) as typeof typed;
  const domainHash = hashDomain({ domain: rpc.domain, types: { EIP712Domain: rpc.types.EIP712Domain } });
  const messageHash = hashStruct({ data: rpc.message, primaryType: rpc.primaryType, types: { PaymentAuthorization: rpc.types.PaymentAuthorization } });
  expect(keccak256(concat(['0x1901', domainHash, messageHash]))).toBe('0x65b68bd6858a7947aef50aa010ad17946ee527a79ebc0d7185603fbfe70f157c');
  expect(paymentDigest(terms, 31337n, adapter)).toBe(
    '0x65b68bd6858a7947aef50aa010ad17946ee527a79ebc0d7185603fbfe70f157c',
  );
});
