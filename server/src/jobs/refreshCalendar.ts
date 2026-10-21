import { confirmDate, inTransaction, mergeFinnhubRow, reportsAwaitingDate, setEstimatedDate, upsertCalendarRow } from '../db/repo.js';
import { addDays, isWeekend } from '../domain/marketCalendar.js';
import { BlockedError, blockAware } from '../sources/failover.js';
import type { CalendarRow } from '../types.js';
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

/** Most reports a Yahoo date check covers per run (Yahoo answers one a second). */
const YAHOO_DATE_CHECKS = 60;

/**
 * Backup for the Nasdaq calendar: Yahoo's next earnings date for reports not yet out. A date that
 * differs from the stored one replaces it, marked 'estimated' until Nasdaq lists a date again.
 */
export async function refreshYahooDates(ctx: JobContext, from: string, to: string): Promise<void> {
  for (const r of reportsAwaitingDate(ctx.db, from, to).slice(0, YAHOO_DATE_CHECKS)) {
    const summary = await ctx.sources.yahooSummary(r.symbol);
    const date = summary?.nextEarningsDate;
    if (date && date >= from && date !== r.reportDate) setEstimatedDate(ctx.db, r.id, date);
  }
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
