import { hashTypedData, isAddress } from 'viem';
import { operationId as coreOperationId, validateOperationShape } from '@confidential-utxo/core';
import type { LocalDraft } from '@confidential-utxo/core';
import type { Address, OperationId, PaymentId } from './domain.js';
import { SchemaError } from './schema.js';

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

export interface PaymentTerms {
  readonly operationId: OperationId;
  readonly owner: Address;
  readonly ethAmount: bigint;
  readonly token: Address;
  readonly minAmountOut: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
}

export interface PaymentDeployment {
  readonly adapter: Address;
  readonly token: Address;
  readonly pool: Address;
  readonly router: Address;
  readonly factory: Address;
  readonly weth: Address;
  readonly pair: Address;
}

export type WithdrawalBindingInput = Pick<LocalDraft, 'context' | 'request' | 'operationId' | 'rangeProofs'>;

const paymentTypes = {
  PaymentAuthorization: [
    { name: 'operationId', type: 'bytes32' },
    { name: 'owner', type: 'address' },
    { name: 'ethAmount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function validAddress(value: string): boolean {
  return isAddress(value, { strict: false }) && !sameAddress(value, ZERO_ADDRESS);
}

function checkTerms(terms: PaymentTerms, chainId: bigint, adapter: Address): void {
  if (chainId <= 0n || !validAddress(adapter) || !validAddress(terms.owner)
    || !validAddress(terms.token) || !validAddress(terms.recipient)
    || !/^0x[0-9a-fA-F]{64}$/.test(terms.operationId)
    || terms.ethAmount <= 0n || terms.ethAmount > UINT256_MAX
    || terms.minAmountOut <= 0n || terms.minAmountOut > UINT256_MAX
    || terms.deadline <= 0n || terms.deadline > UINT64_MAX) {
    throw new SchemaError('INVALID_FIELD', 'paymentTerms');
  }
}

export function paymentDigest(terms: PaymentTerms, chainId: bigint, adapter: Address): PaymentId {
  checkTerms(terms, chainId, adapter);
  return hashTypedData({
    domain: {
      name: 'Ethereum Confidential UTXO Uniswap Payment',
      version: '1',
      chainId,
      verifyingContract: adapter,
    },
    types: paymentTypes,
    primaryType: 'PaymentAuthorization',
    message: terms,
  }) as PaymentId;
}

export function assertWithdrawalBinding(
  withdrawal: WithdrawalBindingInput,
  terms: PaymentTerms,
  deployment: PaymentDeployment,
): void {
  checkTerms(terms, 1n, deployment.adapter);
  const request = withdrawal.request;
  validateOperationShape(request);
  const computedId = coreOperationId(withdrawal.context, request);
  const forbiddenRecipients = [
    ZERO_ADDRESS, deployment.adapter, deployment.pool, deployment.router,
    deployment.factory, deployment.weth, deployment.token, deployment.pair,
  ];
  if (request.kind !== 2 || request.d !== 0n
    || request.inputIds.length !== 1 || request.outputs.length !== 1
    || withdrawal.rangeProofs.length !== 1
    || withdrawal.context.chainId <= 0n
    || !sameAddress(withdrawal.context.pool, deployment.pool)
    || !sameAddress(request.owner, terms.owner)
    || !sameAddress(request.outputs[0]!.owner, terms.owner)
    || request.w !== terms.ethAmount
    || !sameAddress(request.destination, deployment.adapter)
    || !sameAddress(terms.token, deployment.token)
    || forbiddenRecipients.some((recipient) => sameAddress(terms.recipient, recipient))
    || computedId.toLowerCase() !== withdrawal.operationId.toLowerCase()
    || computedId.toLowerCase() !== terms.operationId.toLowerCase()) {
    throw new SchemaError('INVALID_FIELD', 'withdrawalBinding');
  }
}
