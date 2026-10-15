import { inTransaction, upsertCalendarRow } from '../db/repo.js';
import { addDays, isWeekend } from '../domain/marketCalendar.js';
import type { CalendarRow } from '../types.js';
import { type JobContext, track } from './context.js';

export function storeCalendarRows(ctx: JobContext, rows: CalendarRow[]): void {
  const now = ctx.now();
  const today = ctx.today();
  inTransaction(ctx.db, () => {
    for (const row of rows) upsertCalendarRow(ctx.db, row, now, today);
  });
}

/** Today through today+days (spec 7: every 2 hours). */
export async function refreshCalendar(ctx: JobContext, days = 90): Promise<void> {
  const today = ctx.today();
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    if (isWeekend(date)) continue;
    const rows = await track(ctx, 'nasdaq', () => ctx.sources.calendar(date));
    if (rows) storeCalendarRows(ctx, rows);
  }
}
