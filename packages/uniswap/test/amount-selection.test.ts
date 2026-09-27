import { expect, it } from 'vitest';
import { automaticMinimum, parseEthAmount } from '../src/amount.js';
import { selectPayInput } from '../src/selection.js';
import type { Address, InputId } from '../src/domain.js';
import type { PayInput } from '../src/selection.js';

const owner = `0x${'11'.repeat(20)}` as Address;
const otherOwner = `0x${'22'.repeat(20)}` as Address;
const input = (suffix: number, valueWei: bigint, state: PayInput['state'] = 'available', inputOwner = owner): PayInput => ({
  id: `0x${suffix.toString(16).padStart(64, '0')}` as InputId,
  valueWei,
  state,
  owner: inputOwner,
});

it('parses a strict positive ETH decimal into exact wei', () => {
  expect(parseEthAmount('0.000000000000000001')).toBe(1n);
  expect(parseEthAmount('1.000000000000000001')).toBe(1_000_000_000_000_000_001n);
  expect(parseEthAmount('42')).toBe(42_000_000_000_000_000_000n);
});

it.each(['', '0', '0.0', '-1', '+1', '1e-3', '1.', '.1', '01', ' 1', '1 ', '0.0000000000000000001', '1.0000000000000000001', '115792089237316195423570985008687907853269984665640564039458'])('rejects invalid or overflowing ETH input %s', (value) => {
  expect(() => parseEthAmount(value)).toThrow();
});

it('distinguishes empty, zero, malformed and overflowing amounts', () => {
  expect(() => parseEthAmount('')).toThrowError(expect.objectContaining({ code: 'EMPTY_AMOUNT' }));
  expect(() => parseEthAmount('0.0')).toThrowError(expect.objectContaining({ code: 'ZERO_AMOUNT' }));
  expect(() => parseEthAmount('1e-3')).toThrowError(expect.objectContaining({ code: 'INVALID_DECIMAL' }));
  expect(() => parseEthAmount('115792089237316195423570985008687907853269984665640564039458'))
    .toThrowError(expect.objectContaining({ code: 'AMOUNT_OVERFLOW' }));
});

it('requires a positive quote and calculates the integer minimum', () => {
  expect(automaticMinimum(1n)).toBe(1n);
  expect(automaticMinimum(199n)).toBe(197n);
  expect(() => automaticMinimum(0n)).toThrow();
});

it('selects the smallest eligible input with unsigned ID tie breaking', () => {
  const selected = selectPayInput([input(3, 10n), input(2, 8n), input(1, 8n)], 7n, owner);
  expect(selected?.id).toBe(input(1, 8n).id);
  expect(selectPayInput([input(1, 7n)], 7n, owner)).toBeUndefined();
  expect(selectPayInput([input(1, 8n)], 7n, owner)?.valueWei).toBe(8n);
});

it('excludes reserved, unknown, unreceived, and another owner’s input', () => {
  const selected = selectPayInput([
    input(1, 8n, 'reserved'),
    input(2, 8n, 'unknown'),
    input(3, 8n, 'pending'),
    input(4, 8n, 'receipt-invalid'),
    input(5, 8n, 'available', otherOwner),
    input(6, 9n),
  ], 7n, owner);
  expect(selected?.id).toBe(input(6, 9n).id);
});
