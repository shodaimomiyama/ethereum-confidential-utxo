import { SchemaError } from './schema.js';

const WEI_PER_ETH = 10n ** 18n;
const UINT256_MAX = (1n << 256n) - 1n;
const ETH_DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;

export function parseEthAmount(input: string): bigint {
  const match = ETH_DECIMAL.exec(input);
  if (match === null) throw new SchemaError('INVALID_DECIMAL', 'amount');
  const whole = match[1];
  if (whole === undefined) throw new SchemaError('INVALID_DECIMAL', 'amount');
  const fraction = (match[2] ?? '').padEnd(18, '0');
  const wei = BigInt(whole) * WEI_PER_ETH + BigInt(fraction);
  if (wei === 0n || wei > UINT256_MAX) throw new SchemaError('INVALID_DECIMAL', 'amount');
  return wei;
}

export function automaticMinimum(quoteOut: bigint): bigint {
  if (quoteOut <= 0n || quoteOut > UINT256_MAX) {
    throw new SchemaError('INVALID_DECIMAL', 'quoteOut');
  }
  const minimum = quoteOut * 99n / 100n;
  return minimum > 0n ? minimum : 1n;
}
