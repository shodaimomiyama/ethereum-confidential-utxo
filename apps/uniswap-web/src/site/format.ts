export function formatEth(wei: bigint): string {
  const sign = wei < 0n ? '-' : '';
  const absolute = wei < 0n ? -wei : wei;
  const whole = absolute / 10n ** 18n;
  const fraction = (absolute % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function formatUtc(seconds: number | bigint): string {
  if (typeof seconds === 'number') {
    if (!Number.isFinite(seconds)) return 'Time unavailable';
    if (Math.abs(seconds) > 8_640_000_000_000) return `${seconds} Unix seconds (outside calendar display range)`;
    return new Date(seconds * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  }
  if (seconds > 8_640_000_000_000n || seconds < -8_640_000_000_000n) return `${seconds} Unix seconds (outside calendar display range)`;
  return new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
