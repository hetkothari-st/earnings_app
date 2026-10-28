import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import {
  confirmEuropePeriod, type EuropePending, europeReportsBetween, type EuropeStock, setEuropeEstimates, setEuropeProfile,
} from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import { trackIn, type EuropeJobContext } from './context.js';
import { yahooSource } from './stocks.js';

/** Ruling 12 summary tiers. */
export const EUROPE_TIER_A_MAX_AGE_MS = 25 * 60_000;
export const EUROPE_TIER_B_MAX_AGE_MS = 12 * 3_600_000;
/** At most this many summary requests per estimates run, per market (Ruling 12). */
export const EUROPE_SUMMARY_BUDGET = 600;
/** Tier A rows (visible or watched) up to this far ahead get estimates. */
const TIER_A_DAYS = 180;
const TIER_B_DAYS = 14;

type Trend = YahooForeignSummary['trend'][number];

/** The market's calendar date arithmetic (London for UK, Paris for EU: day counts are the same everywhere). */
export const addDaysEurope = (ctx: Pick<EuropeJobContext, 'market'>, d: string, n: number): string =>
  calendarFor(ctx.market === 'UK' ? 'LSE' : 'PAR').addDays(d, n);

/**
 * The trend item for a report (JP Ruling 5): a fourth-quarter (full-year) row prefers the year item (`0y` / `+1y`)
 * whose end equals the period end, else the quarter item; Q1–Q3 rows take quarter items (`0q` / `+1q`) only.
 */
export function europeTrendFor(trend: Trend[], periodEnd: string, fiscalQuarter: 1 | 2 | 3 | 4): { item: Trend; span: 'quarter' | 'year' } | null {
  const isYear = (t: Trend) => t.period === '0y' || t.period === '+1y';
  const isQuarter = (t: Trend) => t.period === '0q' || t.period === '+1q';
  if (fiscalQuarter === 4) {
    const year = trend.find((t) => isYear(t) && t.periodEnd === periodEnd);
    if (year) return { item: year, span: 'year' };
  }
  const quarter = trend.find((t) => isQuarter(t) && t.periodEnd === periodEnd);
  return quarter ? { item: quarter, span: 'quarter' } : null;
}

/** The `0q` end date of a summary's trend (Ruling 7: equal to a row's period end, it confirms that period). */
export const trendQuarterEnd = (y: YahooForeignSummary): string | null => y.trend.find((t) => t.period === '0q')?.periodEnd ?? null;

/**
 * Consensus, sector / industry (assetProfile) and the fiscal-year end from one summary onto the given reports of its
 * stock. Currencies are stored exactly as Yahoo states each side: `earningsTrend` is in the reporting currency
 * (BT-A.L GBP, VOD.L EUR, AZN.L USD), never assumed to be the pence of the `.L` quote, and never converted. A side
 * without a currency is skipped (uncertain means blank). The market cap is stored only with the currency it is in
 * (`europeCapCurrency`: pounds for a pence line). A summary fiscal-year end is stored (source `yahoo`) only when the stock has none (Ruling 6). A row whose
 * period end equals the trend's `0q` end is confirmed (Ruling 7).
 */
export function applyEuropeSummary(
  ctx: EuropeJobContext, stock: Pick<EuropeStock, 'symbol' | 'fyEndMonth'>,
  reports: Pick<EuropePending, 'id' | 'periodEnd' | 'fiscalQuarter'>[], y: YahooForeignSummary,
): void {
  const fy = stock.fyEndMonth == null && y.fyEndMonth != null ? { fyEndMonth: { month: y.fyEndMonth, source: 'yahoo' as const } } : {};
  setEuropeProfile(ctx.db, stock.symbol, {
    name: null, sector: y.sector, industry: y.industry,
    marketCap: y.marketCap, marketCapCurrency: y.marketCapCurrency ?? null, asOf: y.marketCapAsOf, ...fy,
  }, ctx.now());
  const q0 = trendQuarterEnd(y);
  for (const r of reports) {
    if (q0 != null && q0 === r.periodEnd) confirmEuropePeriod(ctx.db, r.id);
    const m = europeTrendFor(y.trend, r.periodEnd, r.fiscalQuarter);
    if (!m) continue;
    const t = m.item;
    const epsOk = t.eps != null && t.epsCurrency != null;
    const revenueOk = t.revenue != null && t.revenueCurrency != null;
    if (!epsOk && !revenueOk) continue;
    setEuropeEstimates(ctx.db, r.id, {
      eps: epsOk ? t.eps : null, epsAnalysts: epsOk ? t.epsAnalysts : null, epsCurrency: epsOk ? t.epsCurrency : null,
      revenue: revenueOk ? t.revenue : null, revenueAnalysts: revenueOk ? t.revenueAnalysts : null,
      revenueCurrency: revenueOk ? t.revenueCurrency : null, span: m.span,
    }, ctx.now());
  }
}

/** Reports of `symbol` that take estimates from a summary fetched today: dated `[today−3, today+180]`. */
export function europeEstimateRows(ctx: EuropeJobContext, symbol: string): EuropePending[] {
  const today = ctx.today();
  return europeReportsBetween(ctx.db, ctx.market, addDaysEurope(ctx, today, -3), addDaysEurope(ctx, today, TIER_A_DAYS))
    .filter((r) => r.symbol === symbol);
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Estimates by Ruling 12 tiers: tier A (visible ∪ watched symbols, rows to +180 days) with a 25-minute max age, tier B
 * (rows dated `[today−3, today+14]`) with 12 h. One summary per symbol, nearest report date first, at most `budget`
 * (600) summary requests per run. The rolling date sweep also applies every summary it fetches, so rows outside both
 * tiers still get estimates once a day.
 */
export async function refreshEuropeEstimates(ctx: EuropeJobContext, opts: { budget?: number } = {}): Promise<void> {
  const budget = opts.budget ?? EUROPE_SUMMARY_BUDGET;
  const today = ctx.today();
  const tierA = new Set(ctx.tierA());
  const all = europeReportsBetween(ctx.db, ctx.market, addDaysEurope(ctx, today, -3), addDaysEurope(ctx, today, TIER_A_DAYS));
  const tierBEnd = addDaysEurope(ctx, today, TIER_B_DAYS);
  const fyEnd = new Map((ctx.db.prepare('SELECT symbol, fy_end_month FROM europe_stocks WHERE market = ?').all(ctx.market) as
    { symbol: string; fy_end_month: number | null }[]).map((s) => [s.symbol, s.fy_end_month]));
  const bySymbol = new Map<string, { rows: EuropePending[]; nearest: number; tierA: boolean }>();
  for (const r of all) {
    const a = tierA.has(r.symbol);
    if (!a && r.reportDate > tierBEnd) continue;
    const e = bySymbol.get(r.symbol) ?? { rows: [], nearest: Infinity, tierA: a };
    e.rows.push(r);
    e.nearest = Math.min(e.nearest, dayDiff(r.reportDate, today));
    bySymbol.set(r.symbol, e);
  }
  const queue = [...bySymbol.entries()]
    .sort(([sa, a], [sb, b]) => a.nearest - b.nearest || Number(b.tierA) - Number(a.tierA) || sa.localeCompare(sb))
    .slice(0, Math.max(0, budget));
  for (const [symbol, e] of queue) {
    const maxAge = e.tierA ? EUROPE_TIER_A_MAX_AGE_MS : EUROPE_TIER_B_MAX_AGE_MS;
    const y = await trackIn(ctx, yahooSource(ctx, 'summary'), () => ctx.yahooSummary(symbol, maxAge));
    if (!y) continue;
    applyEuropeSummary(ctx, { symbol, fyEndMonth: fyEnd.get(symbol) ?? null }, e.rows, y);
  }
}
