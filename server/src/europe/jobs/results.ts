import { europeReportsBetween, mergeEuropeActuals, recordEuropeRelease } from '../db/europeRepo.js';
import { trackIn, type EuropeJobContext } from './context.js';
import { addDaysEurope } from './estimates.js';
import { yahooSource } from './stocks.js';

/** Checked every 2 h: a cached summary younger than this is reused. */
export const EUROPE_RESULTS_MAX_AGE_MS = 100 * 60_000;
/** Basic rows dated this many days back are still checked (Yahoo's actuals can lag the release). */
const LOOKBACK_DAYS = 20;

/**
 * Basic-level "results out" from Yahoo: rows dated `[today−20, today]` with no EPS stored get one summary per symbol.
 * The signal is an earningsHistory entry whose period end is exactly the row's (never the nearest month: a late
 * reporter's FY-Dec actual never lands on a 2026-03-31 row, Review Focus 1). Its EPS, with the currency Yahoo states
 * (an entry without one is skipped), is merged as source `yahoo`, span `quarter`, into Q1 and Q3 rows only (controller
 * ruling, fix round 1: never into an H1 or FY row, whose Yahoo figure may span 6 or 12 months); the release still flips: `mergeEuropeActuals` keeps SEC and
 * ESEF values (a lower source never replaces a higher one). Then the release is recorded at the job's run time
 * (Ruling 10: Yahoo counts only for basic rows; an earlier PR Newswire / DILA / SEC time is kept). Full-level rows are
 * left to SEC. Returns the changed ids.
 */
export async function refreshEuropeYahooResults(ctx: EuropeJobContext): Promise<number[]> {
  const today = ctx.today();
  const due = europeReportsBetween(ctx.db, ctx.market, addDaysEurope(ctx, today, -LOOKBACK_DAYS), today)
    .filter((r) => r.level === 'basic' && !r.hasEps);
  const changed: number[] = [];
  const summaries = new Map<string, Awaited<ReturnType<EuropeJobContext['yahooSummary']>> | undefined>();
  for (const r of due) {
    if (!summaries.has(r.symbol)) {
      summaries.set(r.symbol, await trackIn(ctx, yahooSource(ctx, 'summary'), () => ctx.yahooSummary(r.symbol, EUROPE_RESULTS_MAX_AGE_MS)));
    }
    const y = summaries.get(r.symbol);
    if (!y) continue;
    const eps = y.epsHistory.find((h) => h.periodEnd === r.periodEnd && h.currency != null);
    if (!eps) continue;
    // Only a true quarter row (Q1 / Q3) takes Yahoo's figure: at an H1 or FY end it may be a 6- or 12-month one.
    const quarterRow = r.fiscalQuarter === 1 || r.fiscalQuarter === 3;
    const merged = quarterRow && mergeEuropeActuals(ctx.db, r.id, {
      eps: { basic: eps.actual, diluted: null, currency: eps.currency!, span: 'quarter', ytdMonths: null },
      source: 'yahoo',
    }, ctx.now());
    const released = recordEuropeRelease(ctx.db, r.id, { at: ctx.now(), source: 'yahoo', timing: null });
    if (merged || released) changed.push(r.id);
  }
  return changed;
}
