import type { Timing } from '../types.js';

/**
 * Parses numeric text like "4.60\n/", "-0.15", "aa.aa", "-" into a number or null.
 */
export function parseInvestingEps(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.split('/')[0]?.replace(/[^\d.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses revenue string with multipliers like "46.72B\n/", "500M", "100K", "1.2T", "-" into scaled number or null.
 */
export function parseInvestingRevenue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const firstPart = raw.split('/')[0]?.trim().toUpperCase();
  if (!firstPart || firstPart === '-' || firstPart === '--') return null;

  const match = firstPart.match(/(-?[\d.]+)\s*([BMTK])?/);
  if (!match || !match[1]) return null;

  const val = parseFloat(match[1]);
  if (!Number.isFinite(val)) return null;

  const unit = match[2];
  let multiplier = 1;
  if (unit === 'B') multiplier = 1e9;
  else if (unit === 'M') multiplier = 1e6;
  else if (unit === 'K') multiplier = 1e3;
  else if (unit === 'T') multiplier = 1e12;

  return Math.round(val * multiplier);
}

/**
 * Parses surprise string like "+4.07%\n/", "-0.42%" into percentage number (e.g. 4.07) or null.
 */
export function parseInvestingSurprise(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const firstPart = raw.split('/')[0]?.replace(/[^\d.+-]/g, '').trim();
  if (!firstPart || firstPart === '-' || firstPart === '+') return null;
  const num = parseFloat(firstPart);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses timing icon or text from Investing.com table into BMO, AMC, or UNKNOWN.
 */
export function parseInvestingTiming(raw: string | null | undefined): Timing {
  if (!raw) return 'UNKNOWN';
  const lower = raw.toLowerCase();
  if (lower.includes('before') || lower.includes('pre') || lower.includes('sun_rise') || lower.includes('bmo')) {
    return 'BMO';
  }
  if (lower.includes('after') || lower.includes('post') || lower.includes('moon') || lower.includes('amc')) {
    return 'AMC';
  }
  if (lower.includes('during') || lower.includes('dmh')) {
    return 'DMH';
  }
  return 'UNKNOWN';
}
