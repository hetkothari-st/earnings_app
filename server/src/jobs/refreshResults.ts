import { inTransaction, mergeFinnhubRow } from '../db/repo.js';
import { prevTradingDay } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';
import { storeCalendarRows } from './refreshCalendar.js';

/** Previous trading day + today: picks up EPS actuals (Nasdaq) and revenue (Finnhub). */
export async function refreshResults(ctx: JobContext): Promise<void> {
  const today = ctx.today();
  const from = prevTradingDay(today);
  for (const date of [from, today]) {
    const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(date));
    if (rows) storeCalendarRows(ctx, rows);
  }
  const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(from, today));
  if (details) {
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
  }
}
