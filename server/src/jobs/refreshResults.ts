import { actualsByReport, inTransaction, mergeFinnhubRow, mergeInvestingRow } from '../db/repo.js';
import { prevTradingDay } from '../domain/marketCalendar.js';
import { type JobContext, guarded, track } from './context.js';
import { storeCalendarRows } from './refreshCalendar.js';

/**
 * Previous trading day + today: picks up EPS actuals (Investing.com, Nasdaq, Finnhub) and revenue.
 * Returns the ids of reports whose EPS or revenue actual changed, so browsers can be told at once.
 */
export async function refreshResults(ctx: JobContext): Promise<number[]> {
  const today = ctx.today();
  const from = prevTradingDay(today);
  const before = actualsByReport(ctx.db, from, today);
  for (const date of [from, today]) {
    // Fast source; the backup (Yahoo values, below) is the stored data itself.
    const rows = (await guarded(ctx, { name: 'nasdaq', run: () => ctx.sources.calendar(date) }))?.value;
    if (rows) storeCalendarRows(ctx, rows);
  }
  const details = await track(ctx, 'finnhub', () => ctx.sources.earningsDetails(from, today));
  if (details) {
    const now = ctx.now();
    inTransaction(ctx.db, () => {
      for (const d of details) mergeFinnhubRow(ctx.db, d, now);
    });
  }

  // Real-time EPS & revenue actuals from Investing.com scraper
  if (ctx.sources.investing) {
    const invToday = await track(ctx, 'investing', () => ctx.sources.investing!('today', today));
    const invYesterday = await track(ctx, 'investing', () => ctx.sources.investing!('yesterday', from));
    const investingRows = [...(invToday ?? []), ...(invYesterday ?? [])];
    if (investingRows.length) {
      const now = ctx.now();
      inTransaction(ctx.db, () => {
        for (const r of investingRows) mergeInvestingRow(ctx.db, r, now);
      });
    }
  }

  const after = actualsByReport(ctx.db, from, today);
  return [...after].filter(([id, v]) => (before.get(id) ?? 'null|null') !== v).map(([id]) => id);
}
