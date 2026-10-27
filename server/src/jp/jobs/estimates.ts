import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import { type JpPending, jpReportsBetween, setJpEstimates, setJpProfile } from '../db/jpRepo.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { yahooJpSymbol } from '../universe.js';
import { trackIn, type JpJobContext } from './context.js';

/** Ruling 10 summary tiers. */
export const JP_TIER_A_MAX_AGE_MS = 25 * 60_000;
export const JP_TIER_B_MAX_AGE_MS = 12 * 3_600_000;
/** At most this many summary requests per estimates run. */
export const JP_SUMMARY_BUDGET = 900;
/** Tier A rows (visible or watched) up to this far ahead get estimates. */
const TIER_A_DAYS = 180;

type Trend = YahooForeignSummary['trend'][number];

/**
 * The trend item for a report (Ruling 5): a fourth-quarter (full-year) row prefers the year item (`0y` / `+1y`)
 * whose end equals the period end, else the quarter item; Q1–Q3 rows take quarter items (`0q` / `+1q`) only.
 */
export function jpTrendFor(trend: Trend[], periodEnd: string, fiscalQuarter: 1 | 2 | 3 | 4): { item: Trend; span: 'quarter' | 'year' } | null {
  const isYear = (t: Trend) => t.period === '0y' || t.period === '+1y';
  const isQuarter = (t: Trend) => t.period === '0q' || t.period === '+1q';
  if (fiscalQuarter === 4) {
    const year = trend.find((t) => isYear(t) && t.periodEnd === periodEnd);
    if (year) return { item: year, span: 'year' };
  }
  const quarter = trend.find((t) => isQuarter(t) && t.periodEnd === periodEnd);
  return quarter ? { item: quarter, span: 'quarter' } : null;
}

/**
 * Consensus and sector / industry from one summary onto the given reports of its stock. One currency per row: a
 * revenue estimate in another currency than the EPS's is stored as null, and an EPS estimate without a currency is
 * skipped (uncertain means blank).
 */
export function applyJpSummary(
  ctx: JpJobContext, code: string, reports: Pick<JpPending, 'id' | 'periodEnd' | 'fiscalQuarter'>[], y: YahooForeignSummary,
): void {
  setJpProfile(ctx.db, code, { name: null, sector: y.sector, industry: y.industry, marketCap: y.marketCap, asOf: y.marketCapAsOf }, ctx.now());
  for (const r of reports) {
    const m = jpTrendFor(y.trend, r.periodEnd, r.fiscalQuarter);
    if (!m) continue;
    const t = m.item;
    const epsOk = t.eps != null && t.epsCurrency != null;
    const currency = epsOk ? t.epsCurrency : t.revenueCurrency;
    const revenueOk = t.revenue != null && t.revenueCurrency != null && t.revenueCurrency === currency;
    if (!epsOk && !revenueOk) continue;
    setJpEstimates(ctx.db, r.id, {
      eps: epsOk ? t.eps : null, epsAnalysts: epsOk ? t.epsAnalysts : null,
      revenue: revenueOk ? t.revenue : null, revenueAnalysts: revenueOk ? t.revenueAnalysts : null,
      currency, span: m.span,
    }, ctx.now());
  }
}

/** Reports of `code` that take estimates from a summary fetched today: dated `[today−3, today+180]`. */
export function jpEstimateRows(ctx: JpJobContext, code: string): JpPending[] {
  const today = ctx.todayJST();
  return jpReportsBetween(ctx.db, addDaysJST(today, -3), addDaysJST(today, TIER_A_DAYS)).filter((r) => r.code === code);
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Estimates by Ruling 10 tiers: tier A (visible ∪ watched codes, rows to +180 days) with a 25-minute max age, tier B
 * (rows dated `[today−3, today+14]`) with 12 h. One summary per code, nearest report date first, at most `budget`
 * summary requests per run. The rolling date sweep also applies every summary it fetches (`applyJpSummary`), so
 * rows outside both tiers still get estimates once a day.
 */
export async function refreshJpEstimates(ctx: JpJobContext, opts: { budget?: number } = {}): Promise<void> {
  const budget = opts.budget ?? JP_SUMMARY_BUDGET;
  const today = ctx.todayJST();
  const tierA = new Set(ctx.tierA());
  const all = jpReportsBetween(ctx.db, addDaysJST(today, -3), addDaysJST(today, TIER_A_DAYS));
  const tierBEnd = addDaysJST(today, 14);
  const byCode = new Map<string, { rows: JpPending[]; nearest: number; tierA: boolean }>();
  for (const r of all) {
    const a = tierA.has(r.code);
    if (!a && r.reportDate > tierBEnd) continue;
    const e = byCode.get(r.code) ?? { rows: [], nearest: Infinity, tierA: a };
    e.rows.push(r);
    e.nearest = Math.min(e.nearest, dayDiff(r.reportDate, today));
    byCode.set(r.code, e);
  }
  const queue = [...byCode.entries()]
    .sort(([ca, a], [cb, b]) => a.nearest - b.nearest || Number(b.tierA) - Number(a.tierA) || ca.localeCompare(cb))
    .slice(0, Math.max(0, budget));
  for (const [code, e] of queue) {
    const maxAge = e.tierA ? JP_TIER_A_MAX_AGE_MS : JP_TIER_B_MAX_AGE_MS;
    const y = await trackIn(ctx, 'yahoo-jp-summary', () => ctx.yahooSummary(yahooJpSymbol(code), maxAge));
    if (!y) continue;
    applyJpSummary(ctx, code, e.rows, y);
  }
}
