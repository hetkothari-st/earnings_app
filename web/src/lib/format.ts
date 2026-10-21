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

/** Rupees in crore with Indian grouping: "₹1,23,456.78 Cr"; losses "−₹12.5 Cr". */
export function formatInrCr(rupees: number | null): string {
  if (rupees == null) return '—';
  const cr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Math.abs(rupees) / 1e7);
  return `${rupees < 0 ? '−' : ''}₹${cr} Cr`;
}

/** EPS in rupees: "₹12.34", "−₹0.50". */
export function formatEpsInr(eps: number | null): string {
  if (eps == null) return '—';
  return `${eps < 0 ? '−' : ''}₹${Math.abs(eps).toFixed(2)}`;
}
