/**
 * Reads revenue and diluted GAAP EPS from an HK issuer's results release (6-K EX-99.1 or the 6-K itself).
 *
 * - Currency (Ruling 9): the income-statement headers are scanned; RMB is taken when present (Chinese ADR
 *   issuers print a US$ "convenience translation" column beside it), else HK$, else US$. Only that currency's
 *   columns are read and the figures are never converted.
 * - EPS (Ruling 8): diluted GAAP per ordinary share when stated, else per ADS (`epsBasis: 'ads'`). Never
 *   converted with the ADR ratio; non-GAAP never read.
 * - Uncertain means blank: no currency stated, no unit, or disagreeing candidates → null.
 */
import type { HkPeriodKind } from '../domain/period.js';
import { currenciesIn, parseTables, readRelease, type Currency, type ReaderOptions } from '../../sources/releaseReader.js';

export interface HkReleaseValues {
  revenue: number | null;
  revenueCurrency: string | null;
  eps: number | null;
  epsCurrency: string | null;
  epsBasis: 'share' | 'ads' | null;
  notes: string[];
}

const SPAN: Record<HkPeriodKind, ReaderOptions['span']> = { Q: 'quarter', H: 'half', FY: 'year' };

/** First cell of an income-statement line: a per-share / per-ADS or revenue row. */
const STATEMENT_ROW = /per (diluted |common |basic )?share|per (class [a-z] )?ordinary share|per ads\b|per american depositary|earnings per|\beps\b|^\s*(total )?(net )?revenues?\b/i;
const NUMBER = /\d/;

/**
 * Currencies named in the headers of the tables that carry an income-statement line: their non-numeric rows,
 * plus currency marks on those lines' labels ("Diluted earnings per share ($)").
 */
export function statementCurrencies(html: string): Set<Currency | '$'> {
  const text: string[] = [];
  for (const t of parseTables(html)) {
    const label = (r: (typeof t.rows)[number]) => r.find((c) => c.text)?.text ?? '';
    const lines = t.rows.filter((r) => STATEMENT_ROW.test(label(r)) && r.slice(r.findIndex((c) => c.text) + 1).some((c) => NUMBER.test(c.text)));
    if (!lines.length) continue;
    for (const r of t.rows) if (!r.slice(1).some((c) => NUMBER.test(c.text))) text.push(r.map((c) => c.text).join(' '));
    for (const r of lines) text.push(label(r));
  }
  return currenciesIn(text.join(' '));
}

/** Ruling 9: RMB if present, else HK$, else US$ (a plain "$" counts as US$ only when nothing else is named). */
export function pickCurrency(found: Set<Currency | '$'>): Currency | null {
  if (found.has('CNY')) return 'CNY';
  if (found.has('HKD')) return 'HKD';
  if (found.has('USD') || found.has('$')) return 'USD';
  return null;
}

export function readHkRelease(html: string, period: { periodEnd: string; kind: HkPeriodKind }): HkReleaseValues {
  const currency = pickCurrency(statementCurrencies(html));
  if (!currency) return { revenue: null, revenueCurrency: null, eps: null, epsCurrency: null, epsBasis: null, notes: ['no currency stated in the income-statement headers'] };
  const r = readRelease(html, { periodEnd: period.periodEnd, span: SPAN[period.kind], profile: 'hk', currency });
  const eps = r.epsShare ?? r.epsAds;
  return {
    revenue: r.revenue,
    revenueCurrency: r.revenue === null ? null : currency,
    eps,
    epsCurrency: eps === null ? null : currency,
    epsBasis: r.epsShare !== null ? 'share' : r.epsAds !== null ? 'ads' : null,
    notes: r.notes,
  };
}
