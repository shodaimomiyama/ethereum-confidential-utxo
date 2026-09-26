import type { Address, Bytes32 } from './domain.js';

export type SchemaErrorCode =
  | 'INVALID_OBJECT'
  | 'INVALID_DECIMAL'
  | 'INVALID_BYTES32'
  | 'INVALID_ADDRESS'
  | 'INVALID_REVISION'
  | 'INVALID_FIELD';

export class SchemaError extends Error {
  constructor(
    readonly code: SchemaErrorCode,
    readonly field?: string,
  ) {
    super(code);
    this.name = 'SchemaError';
  }
}

export function parseJsonObject(value: unknown, field?: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaError('INVALID_OBJECT', field);
  }
  return value as Record<string, unknown>;
}

export function parseUintString(value: unknown, field?: string, max?: bigint): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SchemaError('INVALID_DECIMAL', field);
  }
  const parsed = BigInt(value);
  if (max !== undefined && parsed > max) {
    throw new SchemaError('INVALID_DECIMAL', field);
  }
  return parsed;
}

export function parseBytes32(value: unknown, field?: string): Bytes32 {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new SchemaError('INVALID_BYTES32', field);
  }
  return value as Bytes32;
}

export function parseAddress(value: unknown, field?: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new SchemaError('INVALID_ADDRESS', field);
  }
  return value as Address;
}

export function parseRevision(value: unknown, field?: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError('INVALID_REVISION', field);
  }
  return value;
}

export function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError('INVALID_FIELD', field);
  }
  return value;
}

export function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError('INVALID_FIELD', field);
  }
  return value;
}
