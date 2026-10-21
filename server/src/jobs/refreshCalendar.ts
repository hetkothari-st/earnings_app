import { confirmDate, inTransaction, insertEstimatedReport, mergeFinnhubRow, reportsAwaitingDate, setEstimatedDate, symbolsWithoutUpcoming, upsertCalendarRow } from '../db/repo.js';
import { addDays, isWeekend } from '../domain/marketCalendar.js';
import { BlockedError, blockAware } from '../sources/failover.js';
import type { CalendarRow } from '../types.js';
import { allWatched } from '../watchlist/store.js';
import { type JobContext, guarded, track } from './context.js';

export function storeCalendarRows(ctx: JobContext, rows: CalendarRow[]): void {
  const now = ctx.now();
  const today = ctx.today();
  inTransaction(ctx.db, () => {
    for (const row of rows) {
      upsertCalendarRow(ctx.db, row, now, today);
      confirmDate(ctx.db, row.symbol, row.reportDate); // Nasdaq's word beats an earlier Yahoo estimate
    }
  });
}

const MAX_YAHOO_SHIFT_DAYS = 14;
const daysApart = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Most reports a Yahoo date check covers per run (Yahoo answers one a second). */
const YAHOO_DATE_CHECKS = 60;

/**
 * Backup for the Nasdaq calendar: Yahoo's next earnings date, only for reports whose date is already an
 * estimate. A date Nasdaq confirmed is never touched; Nasdaq listing the report again takes over.
 */
export async function refreshYahooDates(ctx: JobContext, from: string, to: string): Promise<void> {
  let tried = 0;
  let failed = 0;
  let lastError: unknown;
  for (const r of reportsAwaitingDate(ctx.db, from, to).slice(0, YAHOO_DATE_CHECKS)) {
    tried++;
    try {
      const date = (await ctx.sources.yahooSummary(r.symbol))?.nextEarningsDate;
      // Only a date inside the window and within 14 days of the stored one: after a release Yahoo rolls on to next quarter.
      if (date && date >= from && date <= to && date !== r.reportDate && daysApart(date, r.reportDate) <= MAX_YAHOO_SHIFT_DAYS) {
        setEstimatedDate(ctx.db, r.id, date);
      }
    } catch (err) {
      failed++; // one symbol's error does not stop the others
      lastError = err;
    }
  }
  if (tried > 0 && failed === tried) throw lastError; // nothing worked: Yahoo itself is down
  await refreshWatchedEstimates(ctx);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Sep/2026' for a date in Oct 2026: the latest calendar quarter end before the date. */
function quarterLabelBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const endMonth = Math.floor((month - 1) / 3) * 3; // 0 = December of last year
  return endMonth === 0 ? `Dec/${year - 1}` : `${MONTHS[endMonth - 1]}/${year}`;
}

/**
 * Yahoo's next date for every watched US stock that has no upcoming report: an 'estimated' row, until Nasdaq
 * lists it. A stock with a Nasdaq-confirmed upcoming row is never touched.
 */
export async function refreshWatchedEstimates(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  let tried = 0;
  let failed = 0;
  let lastError: unknown;
  for (const symbol of symbolsWithoutUpcoming(ctx.db, allWatched(ctx.db, 'US'), today).slice(0, YAHOO_DATE_CHECKS)) {
    tried++;
    try {
      const date = (await ctx.sources.yahooSummary(symbol))?.nextEarningsDate;
      if (date && date >= today) insertEstimatedReport(ctx.db, { symbol, fiscalQuarter: quarterLabelBefore(date), reportDate: date }, ctx.now());
    } catch (err) {
      failed++;
      lastError = err;
    }
  }
  if (tried > 0 && failed === tried) throw lastError;
}

/**
 * Today through today+days (spec 7: the next 14 days every 5 minutes, 90 days every 2 hours). Nasdaq is the fast
 * source; while it fails or is blocked, Yahoo's dates stand in (marked estimated).
 */
export async function refreshCalendar(ctx: JobContext, days = 90): Promise<void> {
  const today = ctx.today();
  const nasdaq = async (): Promise<void> => {
    let firstError: unknown;
    for (let i = 0; i <= days; i++) {
      const date = addDays(today, i);
      if (isWeekend(date)) continue;
      try {
        const rows = await blockAware('nasdaq', () => ctx.sources.calendar(date));
        storeCalendarRows(ctx, rows);
      } catch (err) {
        if (err instanceof BlockedError) throw err; // every further date would be refused too
        firstError ??= err;                         // one bad date does not stop the others
      }
    }
    if (firstError) throw firstError;
  };
  await guarded(ctx, { name: 'nasdaq', run: nasdaq }, { name: 'yahoo', run: () => refreshYahooDates(ctx, today, addDays(today, Math.min(days, 14))) });
  // Revenue consensus and timing hints for upcoming reports (spec 6.3, 6.6a).
  const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(today, addDays(today, 14)));
  if (details) {
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
  }
}
