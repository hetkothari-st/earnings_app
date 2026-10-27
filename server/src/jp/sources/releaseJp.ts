/**
 * Reads revenue and EPS (basic, plus diluted) from a Japanese issuer's results release (6-K / EX-99.1), profile 'jp'.
 *
 * - Currency: yen only; a US$ convenience column is skipped. Figures are never converted.
 * - Span (spec: standalone quarter if present, else year-to-date, never subtraction): the three-month column is
 *   read first. Only when it gives neither revenue nor basic EPS, and the period is the 2nd / 3rd / 4th quarter, the
 *   six / nine / twelve-month column is read instead and the values are marked `span: 'ytd'`. A 1st-quarter
 *   document is quarter-only. One span per release; nothing is ever computed from another span.
 * - Uncertain means blank: no unit, disagreeing candidates, ambiguous headers → null.
 */
import { readRelease, type JpIssuer, type ReaderOptions, type ReaderResult } from '../../sources/releaseReader.js';

export type { JpIssuer };

export interface JpReleaseValues {
  revenue: number | null;
  /** Basic EPS in yen. */
  eps: number | null;
  epsDiluted: number | null;
  currency: 'JPY' | null;
  span: 'quarter' | 'ytd' | null;
  ytdMonths: 6 | 9 | 12 | null;
  notes: string[];
}

const YTD: Record<2 | 3 | 4, { span: ReaderOptions['span']; months: 6 | 9 | 12 }> = {
  2: { span: 'half', months: 6 },
  3: { span: 'nine', months: 9 },
  4: { span: 'year', months: 12 },
};

const values = (r: ReaderResult, span: 'quarter' | 'ytd', ytdMonths: 6 | 9 | 12 | null): JpReleaseValues => ({
  revenue: r.revenue,
  eps: r.epsBasic,
  epsDiluted: r.epsGaap,
  currency: 'JPY',
  span,
  ytdMonths,
  notes: r.notes,
});

const any = (r: ReaderResult) => r.revenue !== null || r.epsBasic !== null || r.epsGaap !== null;

/** The fiscal-year label: the calendar year in which the fiscal year ends (quarter end + the quarters left). */
export function jpFiscalYear(periodEnd: string, fiscalQuarter: 1 | 2 | 3 | 4): number | undefined {
  const m = periodEnd.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return undefined;
  const months = Number(m[1]) * 12 + (Number(m[2]) - 1) + (4 - fiscalQuarter) * 3;
  return Math.floor(months / 12);
}

/**
 * `issuer`: the issuer's identity from the universe (`jpIssuerFor`) — the only names a group heading may carry besides
 * generic words. Without it a summary headed by any company name is not read as the group.
 */
export function readJpRelease(html: string, period: { periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4; issuer?: JpIssuer }): JpReleaseValues {
  const base = {
    periodEnd: period.periodEnd, profile: 'jp' as const, fiscalQuarter: period.fiscalQuarter,
    fiscalYear: jpFiscalYear(period.periodEnd, period.fiscalQuarter), issuer: period.issuer,
  };
  const q = readRelease(html, { ...base, span: 'quarter' });
  if (q.revenue !== null || q.epsBasic !== null) return values(q, 'quarter', null);
  let notes = q.notes;
  if (period.fiscalQuarter > 1) {
    const ytd = YTD[period.fiscalQuarter as 2 | 3 | 4];
    const y = readRelease(html, { ...base, span: ytd.span });
    notes = [...q.notes, ...y.notes];
    if (any(y)) return { ...values(y, 'ytd', ytd.months), notes };
  }
  if (any(q)) return { ...values(q, 'quarter', null), notes };
  return { revenue: null, eps: null, epsDiluted: null, currency: null, span: null, ytdMonths: null, notes };
}
