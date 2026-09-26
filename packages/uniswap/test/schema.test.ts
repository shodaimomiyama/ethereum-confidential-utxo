import { expect, it } from 'vitest';
import {
  parseAddress,
  parseBytes32,
  parseJsonObject,
  parseRevision,
  parseUintString,
} from '../src/schema.js';

it('accepts canonical unsigned integer strings without precision loss', () => {
  expect(parseUintString('0')).toBe(0n);
  expect(parseUintString('9007199254740993')).toBe(9007199254740993n);
  for (const bad of ['1e3', '-1', '+1', '01', '1.0', 1, null]) {
    expect(() => parseUintString(bad)).toThrowError(/INVALID_DECIMAL/);
  }
});

it('rejects malformed fixed-size identifiers and revisions', () => {
  expect(parseBytes32(`0x${'00'.repeat(32)}`)).toHaveLength(66);
  expect(() => parseBytes32(`0x${'00'.repeat(31)}`)).toThrowError(/INVALID_BYTES32/);
  expect(parseAddress(`0x${'ab'.repeat(20)}`)).toHaveLength(42);
  expect(() => parseAddress(`0x${'ab'.repeat(19)}`)).toThrowError(/INVALID_ADDRESS/);
  expect(() => parseRevision(-1)).toThrowError(/INVALID_REVISION/);
  expect(() => parseRevision(Number.MAX_SAFE_INTEGER + 1)).toThrowError(/INVALID_REVISION/);
});

it('requires an object for JSON records', () => {
  for (const bad of [null, [], 'x', 1]) {
    expect(() => parseJsonObject(bad)).toThrowError(/INVALID_OBJECT/);
  }
});
