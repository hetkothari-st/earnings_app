/**
 * Reads revenue and EPS (basic, plus diluted) from a UK / European issuer's results release (6-K exhibit or 8-K
 * Ex-99.1), profiles 'uk' / 'eu' of the shared release reader.
 *
 * - Currency: as the release states it, never converted. EPS in pence is 'GBp', in pounds 'GBP'; revenue carries its
 *   own currency from the table's allowlisted unit ("£m", "€ million", "DKK million", "(in millions of euros)" …).
 *   A convenience column in another currency is skipped; two currencies left → null.
 * - Span (the JP order): the three-month column is read first. Only when it gives neither revenue nor basic EPS, and
 *   the period is the 2nd / 3rd quarter, the six / nine-month column is read instead (`span: 'ytd'`, 6 / 9). A 4th
 *   quarter is read from the full-year column only (`ytd`, 12): standalone Q4 / H2 / second-half columns are never
 *   read. A 1st-quarter document is quarter-only. One span per release; nothing is ever computed from another span.
 * - Uncertain means blank: no unit, disagreeing candidates, ambiguous headers → null.
 */
import { jpFiscalYear } from '../../jp/sources/releaseJp.js';
import { readRelease, type JpIssuer, type ReaderOptions, type ReaderResult } from '../../sources/releaseReader.js';

export interface EuropeReleaseValues {
  revenue: number | null;
  revenueCurrency: string | null;
  /** Basic EPS, in `epsCurrency`. */
  eps: number | null;
  epsDiluted: number | null;
  epsCurrency: string | null;
  span: 'quarter' | 'ytd' | null;
  ytdMonths: 6 | 9 | 12 | null;
  notes: string[];
}

/** The fields the UK / EU reader gate scores (exact match, `domain/readerGate.ts`). */
export const EUROPE_GATE_FIELDS = ['revenue', 'revenueCurrency', 'eps', 'epsDiluted', 'epsCurrency', 'span', 'ytdMonths'] as const;

const YTD: Record<2 | 3 | 4, { span: ReaderOptions['span']; months: 6 | 9 | 12 }> = {
  2: { span: 'half', months: 6 },
  3: { span: 'nine', months: 9 },
  4: { span: 'year', months: 12 },
};

const values = (r: ReaderResult, span: 'quarter' | 'ytd', ytdMonths: 6 | 9 | 12 | null, notes: string[]): EuropeReleaseValues => ({
  revenue: r.revenue,
  revenueCurrency: r.revenue !== null ? r.revenueCurrency : null,
  eps: r.epsBasic,
  epsDiluted: r.epsGaap,
  epsCurrency: r.epsBasic !== null || r.epsGaap !== null ? r.epsCurrency : null,
  span,
  ytdMonths,
  notes,
});

const any = (r: ReaderResult) => r.revenue !== null || r.epsBasic !== null || r.epsGaap !== null;

/**
 * `issuer`: the issuer's identity from the universe (`europeIssuerFor`); its ticker marks a bank, whose "Total income"
 * line is its revenue.
 */
export function readEuropeRelease(
  html: string,
  period: { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; profile: 'uk' | 'eu'; issuer?: JpIssuer },
): EuropeReleaseValues {
  const base = {
    periodEnd: period.periodEnd, profile: period.profile, fiscalQuarter: period.fiscalQuarter,
    fiscalYear: jpFiscalYear(period.periodEnd, period.fiscalQuarter), issuer: period.issuer,
  };
  let notes: string[] = [];
  let q: ReaderResult | null = null;
  if (period.fiscalQuarter < 4) {
    q = readRelease(html, { ...base, span: 'quarter' });
    notes = q.notes;
    if (q.revenue !== null || q.epsBasic !== null) return values(q, 'quarter', null, notes);
  }
  if (period.fiscalQuarter > 1) {
    const ytd = YTD[period.fiscalQuarter as 2 | 3 | 4];
    const y = readRelease(html, { ...base, span: ytd.span });
    notes = [...notes, ...y.notes];
    if (any(y)) return values(y, 'ytd', ytd.months, notes);
  }
  if (q && any(q)) return values(q, 'quarter', null, notes);
  return { revenue: null, revenueCurrency: null, eps: null, epsDiluted: null, epsCurrency: null, span: null, ytdMonths: null, notes };
}
