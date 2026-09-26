import type { Address, Bytes32 } from './domain.js';
import { automaticMinimum } from './amount.js';
import { parseBytes32, SchemaError } from './schema.js';

const UINT64_MAX = (1n << 64n) - 1n;
const FRESH_MS = 30_000;

export interface RouteAddresses {
  readonly weth: Address;
  readonly dusd: Address;
}

export interface QuoteReader {
  getAmountsOut(inputWei: bigint, path: readonly [Address, Address]): Promise<{
    readonly blockHash: Bytes32;
    readonly blockNumber: bigint;
    readonly amounts: readonly bigint[];
  }>;
}

export interface MonotonicClock {
  now(): number;
}

export interface PayQuote {
  readonly startedAtMs: number;
  readonly blockHash: Bytes32;
  readonly blockNumber: bigint;
  readonly inputWei: bigint;
  readonly quoteOut: bigint;
}

export async function fetchPayQuote(
  reader: QuoteReader,
  inputWei: bigint,
  deployment: RouteAddresses,
  clock: MonotonicClock,
): Promise<PayQuote> {
  if (inputWei <= 0n) throw new SchemaError('INVALID_DECIMAL', 'inputWei');
  const startedAtMs = clock.now();
  if (!Number.isFinite(startedAtMs)) throw new SchemaError('INVALID_FIELD', 'startedAtMs');
  const response = await reader.getAmountsOut(inputWei, [deployment.weth, deployment.dusd]);
  const blockHash = parseBytes32(response.blockHash, 'blockHash');
  if (response.blockNumber < 0n
    || response.amounts.length !== 2
    || response.amounts[0] !== inputWei
    || response.amounts[1] === undefined
    || response.amounts[1] <= 0n) {
    throw new SchemaError('INVALID_FIELD', 'quote');
  }
  return {
    startedAtMs,
    blockHash,
    blockNumber: response.blockNumber,
    inputWei,
    quoteOut: response.amounts[1],
  };
}

export function isQuoteFresh(quote: PayQuote, nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(quote.startedAtMs)) return false;
  const age = nowMs - quote.startedAtMs;
  return age >= 0 && age <= FRESH_MS;
}

export function defaultTerms(quote: PayQuote, latestBlockTime: bigint): {
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
} {
  if (latestBlockTime < 0n || latestBlockTime > UINT64_MAX - 600n) {
    throw new SchemaError('INVALID_FIELD', 'latestBlockTime');
  }
  return {
    minAmountOut: automaticMinimum(quote.quoteOut),
    deadline: latestBlockTime + 600n,
  };
}
