import { recordSourceError } from '../../db/repo.js';
import { upsertJpPastDates } from '../db/jpRepo.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { trackIn, type JpJobContext } from './context.js';

/**
 * Past result dates from the Yahoo bulk calendar, `[today−400, today−1]` (Ruling 10: weekly, and at warm-up while
 * `jp_past_dates` is empty). TAS rows keep their JST timing, other rows a null timing. Yahoo's Tokyo rows in this
 * dataset largely stop in May 2025, so this mostly adds nothing now; it costs one request when empty. An incomplete
 * sweep writes what it got and records a `yahoo-jp-past-dates` error. Returns the number of dates newly added.
 */
export async function refreshJpPastDates(ctx: JpJobContext): Promise<number> {
  const today = ctx.todayJST();
  const sweep = await trackIn(ctx, 'yahoo-jp-past-dates', () => ctx.yahooCalendar(addDaysJST(today, -400), addDaysJST(today, -1)));
  if (!sweep) return 0;
  const added = upsertJpPastDates(ctx.db, sweep.rows
    .filter((r) => r.date < today)
    .map((r) => ({ code: r.code, date: r.date, timing: r.timeType === 'TAS' && r.timing !== 'UNKNOWN' ? r.timing : null })));
  if (!sweep.complete) {
    recordSourceError(ctx.db, 'yahoo-jp-past-dates', `past-dates sweep incomplete: ${sweep.rows.length} rows read`, ctx.now());
  }
  return added;
}
