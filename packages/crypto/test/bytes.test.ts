import { expect, it } from 'vitest';
import { bytesHex, hexBytes } from '../src/bytes.js';
it('round trips every byte including leading zeroes without Node Buffer', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(bytesHex(bytes)).toHaveLength(512);
  expect(bytesHex(bytes).slice(0, 8)).toBe('00010203');
  expect(hexBytes(`0x${bytesHex(bytes).toUpperCase()}`)).toEqual(bytes);
  expect(hexBytes('0x')).toEqual(new Uint8Array());
  for (const invalid of ['0x0', 'ff', '0xgg', '0x 00']) expect(() => hexBytes(invalid)).toThrow(RangeError);
});
