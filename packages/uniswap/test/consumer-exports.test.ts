import { expect, it } from 'vitest';
import * as production from '@confidential-utxo/uniswap';
import * as testing from '@confidential-utxo/uniswap/testing';

it('exposes production schema separately from testing controls', () => {
  expect(typeof production.parseApiRequest).toBe('function');
  expect(typeof production.parseApiResponse).toBe('function');
  expect(typeof testing.createMemoryStore).toBe('function');
  expect(typeof testing.createMockHttp).toBe('function');
  expect(typeof testing.assertHttpConformance).toBe('function');
  expect('createMemoryStore' in production).toBe(false);
  expect('createMockHttp' in production).toBe(false);
});
