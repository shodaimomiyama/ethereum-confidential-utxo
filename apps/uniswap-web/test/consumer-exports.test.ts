import { expect, it } from 'vitest';
import { isActionAllowed } from '@confidential-utxo/uniswap-web/contracts';
import { createMockUiController } from '@confidential-utxo/uniswap-web/mock';
import { assertUiConformance, scenarios } from '@confidential-utxo/uniswap-web/testing';

it('makes view contracts, mock, and conformance entrypoints importable', () => {
  expect(typeof isActionAllowed).toBe('function');
  expect(typeof createMockUiController).toBe('function');
  expect(typeof assertUiConformance).toBe('function');
  expect(scenarios.length).toBeGreaterThan(30);
});
