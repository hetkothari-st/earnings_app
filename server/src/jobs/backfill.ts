import { inTransaction, isBackfilled, markBackfilled, mergeFinnhubRow } from '../db/repo.js';
import { addDays, prevTradingDay, tradingDaysBetween } from '../domain/marketCalendar.js';
import { type JobContext, track } from './context.js';
import { storeCalendarRows } from './refreshCalendar.js';
import { secSync } from './secSync.js';

/** One-time, resumable history load from `start` to the previous trading day. */
export async function backfill(ctx: JobContext, start: string, log: (msg: string) => void = console.log): Promise<void> {
  const end = prevTradingDay(ctx.today());
  const days = tradingDaysBetween(start, end);
  log(`Nasdaq: ${days.length} trading days ${start}..${end}`);
  let done = 0;
  for (const day of days) {
    const key = `nasdaq:${day}`;
    if (!isBackfilled(ctx.db, key)) {
      const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(day));
      if (rows) {
        storeCalendarRows(ctx, rows);
        markBackfilled(ctx.db, key, ctx.now());
      }
    }
    if (++done % 20 === 0) log(`Nasdaq: ${done}/${days.length}`);
  }

  for (let from = start; from <= end; from = addDays(from, 7)) {
    const key = `finnhub:${from}`;
    if (isBackfilled(ctx.db, key)) continue;
    const to = addDays(from, 6) < end ? addDays(from, 6) : end;
    const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(from, to));
    if (!details) continue;
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
    markBackfilled(ctx.db, key, now);
  }
  log('Finnhub: done');

  await secSync(ctx);
  log('SEC: done');
}
