import { expect, it } from 'vitest';
import { defaultTerms, fetchPayQuote, isQuoteFresh } from '../src/quote.js';
import type { Address, Bytes32 } from '../src/domain.js';
import type { PayQuote } from '../src/quote.js';

const weth = `0x${'11'.repeat(20)}` as Address;
const dusd = `0x${'22'.repeat(20)}` as Address;
const blockHash = `0x${'33'.repeat(32)}` as Bytes32;
const quote = (startedAtMs: number, quoteOut = 100n): PayQuote => ({
  startedAtMs, blockHash, blockNumber: 9n, inputWei: 10n, quoteOut,
});

it('includes response latency when evaluating freshness', () => {
  expect(isQuoteFresh(quote(10), 30_010)).toBe(true);
  expect(isQuoteFresh(quote(10), 30_011)).toBe(false);
  expect(isQuoteFresh(quote(10), 9)).toBe(false);
  expect(isQuoteFresh(quote(10), Number.NaN)).toBe(false);
  expect(isQuoteFresh(quote(10), Number.POSITIVE_INFINITY)).toBe(false);
});

it('pins the fixed Router path and request start to one identified block', async () => {
  const seen: unknown[] = [];
  const result = await fetchPayQuote({
    async getAmountsOut(inputWei, path) {
      seen.push({ inputWei, path });
      now = 30_005;
      return { blockHash, blockNumber: 9n, amounts: [inputWei, 101n] };
    },
  }, 10n, { weth, dusd }, { now: () => now });
  expect(seen).toEqual([{ inputWei: 10n, path: [weth, dusd] }]);
  expect(result).toEqual({ startedAtMs: 0, blockHash, blockNumber: 9n, inputWei: 10n, quoteOut: 101n });
  expect(isQuoteFresh(result, now)).toBe(false);
});

let now = 0;

it('rejects a malformed or zero-output Router result', async () => {
  for (const amounts of [[10n], [11n, 5n], [10n, 0n]]) {
    await expect(fetchPayQuote({
      getAmountsOut: async () => ({ blockHash, blockNumber: 9n, amounts }),
    }, 10n, { weth, dusd }, { now: () => 0 })).rejects.toThrow();
  }
});

it('derives automatic minimum and a full-width uint64 deadline', () => {
  expect(defaultTerms(quote(0, 1n), 100n)).toEqual({ minAmountOut: 1n, deadline: 700n });
  expect(defaultTerms(quote(0, 199n), 9007199254740993n)).toEqual({
    minAmountOut: 197n,
    deadline: 9007199254741593n,
  });
  expect(() => defaultTerms(quote(0), (1n << 64n) - 600n)).toThrow();
});
