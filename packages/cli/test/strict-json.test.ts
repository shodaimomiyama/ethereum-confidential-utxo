import { describe, expect, it } from "vitest";
import { base64Bytes, decimalWei, hexBytes, parseExactObject } from "../src/strict-json.js";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("strict CLI data formats", () => {
  it("rejects decoded duplicate keys, including nested ones", () => {
    expect(() => parseExactObject(utf8(String.raw`{"a":1,"\u0061":2}`), ["a"])).toThrow();
    expect(() => parseExactObject(utf8(String.raw`{"a":{"x":1,"\u0078":2}}`), ["a"])).toThrow();
  });

  it("rejects malformed UTF-8, trailing data, and unexpected top-level keys", () => {
    expect(() => parseExactObject(new Uint8Array([0xc3, 0x28]), ["a"])).toThrow();
    expect(() => parseExactObject(utf8('{"a":1} {"a":2}'), ["a"])).toThrow();
    expect(() => parseExactObject(utf8('{"a":1,"secret":"x"}'), ["a"])).toThrow();
    expect(parseExactObject(utf8('{"a":1}'), ["a"])).toEqual({ a: 1 });
  });

  it("accepts only padded canonical standard base64", () => {
    expect(base64Bytes("AQ==", 1)).toEqual(new Uint8Array([1]));
    expect(base64Bytes("/w==", 1)).toEqual(new Uint8Array([255]));
    for (const value of ["AQ", "AQ===", "AQ==\n", "-w=="] as const) {
      expect(() => base64Bytes(value)).toThrow();
    }
    expect(() => base64Bytes("AQ==", 2)).toThrow();
  });

  it("accepts only unsigned canonical decimal wei and exact hex lengths", () => {
    expect(decimalWei("1000")).toBe(1000n);
    expect(decimalWei("0")).toBe(0n);
    for (const value of ["-1", "01", "1e3", "1.0", " 1", 1]) {
      expect(() => decimalWei(value)).toThrow();
    }
    expect(hexBytes("0x01", 1)).toBe("0x01");
    expect(() => hexBytes("0x1", 1)).toThrow();
    expect(() => hexBytes("0x01", 2)).toThrow();
  });
});
