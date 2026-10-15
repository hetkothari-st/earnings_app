import { DateTime } from 'luxon';

export function formatUsd(n: number | null): string {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString('en-US')}`;
}

export function formatUsdFull(n: number | null): string {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
}

export function formatEps(n: number | null): string {
  if (n == null) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

export function formatPct(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function formatDateHeading(date: string): string {
  return DateTime.fromISO(date).setLocale('en-US').toFormat('ccc, LLL d, yyyy');
}

/** Signed change with a true minus sign: "+0.42%", "−1.11%". */
export function formatChange(n: number | null, decimals = 2): string {
  if (n == null) return '—';
  const s = Math.abs(n).toFixed(decimals);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${s}%`;
}

export const changeClass = (n: number | null) => (n == null || n === 0 ? '' : n > 0 ? 'up' : 'down');

export function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

const CURRENCY_PREFIX: Record<string, string> = { USD: '$', TWD: 'NT$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CNY: 'CN¥', CAD: 'C$', HKD: 'HK$' };

/** Compact amount in its own currency: "$1.2B", "NT$1.46T", "SEK 61.2B". Never converted. */
export function formatMoney(n: number | null, currency: string): string {
  const usd = formatUsd(n);
  if (n == null || currency === 'USD') return usd;
  const prefix = CURRENCY_PREFIX[currency] ?? `${currency} `;
  return usd.replace('$', prefix);
}
