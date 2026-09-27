import type { Hex } from "viem";

function invalid(): never {
  throw new Error("INVALID_FORMAT");
}

function rejectDuplicateKeys(source: string): void {
  let cursor = 0;

  function whitespace(): void {
    while (cursor < source.length && /[\t\n\r ]/.test(source[cursor]!)) cursor++;
  }

  function character(expected: string): void {
    if (source[cursor] !== expected) invalid();
    cursor++;
  }

  function string(): string {
    const start = cursor;
    character('"');
    while (cursor < source.length) {
      const char = source[cursor++]!;
      if (char === '"') {
        try { return JSON.parse(source.slice(start, cursor)) as string; }
        catch { invalid(); }
      }
      if (char.charCodeAt(0) < 0x20) invalid();
      if (char !== "\\") continue;
      const escape = source[cursor++];
      if (!escape || !'"\\/bfnrtu'.includes(escape)) invalid();
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor, cursor + 4))) invalid();
        cursor += 4;
      }
    }
    invalid();
  }

  function value(depth: number): void {
    if (depth > 64) invalid();
    whitespace();
    const char = source[cursor];
    if (char === '"') { string(); return; }
    if (char === "{") {
      cursor++;
      whitespace();
      const seen = new Set<string>();
      if (source[cursor] === "}") { cursor++; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (seen.has(key)) invalid();
        seen.add(key);
        whitespace();
        character(":");
        value(depth + 1);
        whitespace();
        if (source[cursor] === "}") { cursor++; return; }
        character(",");
      }
    }
    if (char === "[") {
      cursor++;
      whitespace();
      if (source[cursor] === "]") { cursor++; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (source[cursor] === "]") { cursor++; return; }
        character(",");
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return; }
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = cursor;
    const match = number.exec(source);
    if (!match) invalid();
    cursor = number.lastIndex;
  }

  value(0);
  whitespace();
  if (cursor !== source.length) invalid();
}

export function parseExactObject(bytes: Uint8Array, allowed: readonly string[]): Record<string, unknown> {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { invalid(); }
  rejectDuplicateKeys(source);
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; }
  catch { invalid(); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") invalid();
  const record = parsed as Record<string, unknown>;
  const known = new Set(allowed);
  if (Object.keys(record).some(key => !known.has(key))) invalid();
  return record;
}

export function base64Bytes(value: unknown, length?: number): Uint8Array {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value ||
      (length !== undefined && bytes.length !== length)) invalid();
  return new Uint8Array(bytes);
}

export function decimalWei(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  return BigInt(value);
}

export function hexBytes(value: unknown, bytes: number): Hex {
  if (!Number.isSafeInteger(bytes) || bytes < 0 ||
      typeof value !== "string" ||
      !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) invalid();
  return value as Hex;
}
