import { expect, it } from 'vitest';
import { parseApiResponse } from '@confidential-utxo/uniswap';
import type { ApiRequestBodyMap, ApiSuccessResponseMap, Scope } from '@confidential-utxo/uniswap';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;
const id = `0x${'33'.repeat(32)}` as never;

it('offers route-specific TypeScript request and response contracts', () => {
  const reward: ApiRequestBodyMap['POST /v1/rewards'] = {
    scope,
    requestId: id,
    amountWei: '1',
    recipientInfo: { owner: scope.owner, publicKey: id, signature: `0x${'aa'.repeat(65)}` },
  };
  expect(reward.amountWei).toBe('1');
  const challenge = parseApiResponse('POST /v1/auth/challenge', 200, {
    challengeId: id,
    nonce: id,
    issuedAt: 0,
    expiresAt: 300000,
  });
  if ('error' in challenge) throw new Error('unexpected error response');
  const typed: ApiSuccessResponseMap['POST /v1/auth/challenge'] = challenge;
  expect(typed.expiresAt).toBe(300000);
});
