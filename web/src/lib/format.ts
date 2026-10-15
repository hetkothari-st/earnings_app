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
