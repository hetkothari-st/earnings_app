import { jpReportsBetween, mergeJpActuals } from '../db/jpRepo.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { jpRevenueQuarterLabel } from '../sources/yahooJp.js';
import { yahooJpSymbol } from '../universe.js';
import { trackIn, type JpJobContext } from './context.js';

/** Checked every 2 h: a cached summary younger than this is reused. */
export const JP_RESULTS_MAX_AGE_MS = 100 * 60_000;

/**
 * Basic-level "results out" from Yahoo (controller ruling, replacing the bulk `epsactual` signal): reports dated
 * `[today−3, today]` missing EPS or revenue get one summary per code. EPS comes from earningsHistory in the
 * period-end month (with its currency), revenue from `financialsChart.quarterly` under the calendar-quarter label
 * (`jpRevenueQuarterLabel`) with the financial currency; both span `quarter`, source `yahoo`. A figure without a
 * currency is dropped. `mergeJpActuals` keeps SEC and EDINET values (a lower source never replaces a higher one).
 * Full-level rows are left to SEC. Returns the changed ids.
 */
export async function refreshJpYahooResults(ctx: JpJobContext): Promise<number[]> {
  const today = ctx.todayJST();
  const due = jpReportsBetween(ctx.db, addDaysJST(today, -3), today)
    .filter((r) => r.level === 'basic' && (!r.hasEps || !r.hasRevenue));
  const changed: number[] = [];
  const summaries = new Map<string, Awaited<ReturnType<JpJobContext['yahooSummary']>> | undefined>();
  for (const r of due) {
    if (!summaries.has(r.code)) {
      summaries.set(r.code, await trackIn(ctx, 'yahoo-jp-summary', () => ctx.yahooSummary(yahooJpSymbol(r.code), JP_RESULTS_MAX_AGE_MS)));
    }
    const y = summaries.get(r.code);
    if (!y) continue;
    const month = r.periodEnd.slice(0, 7);
    const eps = r.hasEps ? undefined : y.epsHistory.find((h) => h.periodEnd.slice(0, 7) === month && h.currency != null);
    const label = jpRevenueQuarterLabel(r.periodEnd);
    const rev = r.hasRevenue || y.financialCurrency == null || !label ? undefined : y.revenueQuarters.find((q) => q.label === label);
    if (!eps && !rev) continue;
    const merged = mergeJpActuals(ctx.db, r.id, {
      eps: eps ? { basic: eps.actual, diluted: null, currency: eps.currency!, span: 'quarter', ytdMonths: null } : null,
      revenue: rev ? { value: rev.revenue, currency: y.financialCurrency!, span: 'quarter', ytdMonths: null } : null,
      source: 'yahoo',
    }, ctx.now());
    if (merged) changed.push(r.id);
  }
  return changed;
}
