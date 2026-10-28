import { recordSourceError } from '../../db/repo.js';
import { europeStocks, upsertEuropePastDates } from '../db/europeRepo.js';
import { europeBulkRegions } from './calendar.js';
import { trackIn, type EuropeJobContext } from './context.js';
import { addDaysEurope } from './estimates.js';
import { yahooSource } from './stocks.js';

/**
 * Past result dates from the Yahoo bulk calendar, `[today−400, today−1]`, once per enabled region of the market
 * (`regions`, default `europeBulkRegions`: those marked `bulkCalendar: true`); no enabled region costs no request.
 * Only the market's own stocks are kept. TAS rows keep their local timing, other rows a null timing. An incomplete
 * sweep writes what it got and records a `yahoo-<market>-past-dates` error. Returns the number of dates newly added.
 */
export async function refreshEuropePastDates(ctx: EuropeJobContext, opts: { regions?: readonly string[] } = {}): Promise<number> {
  const regions = opts.regions ?? europeBulkRegions(ctx.market);
  if (regions.length === 0) return 0;
  const today = ctx.today();
  const mine = new Set(europeStocks(ctx.db, ctx.market).map((s) => s.symbol));
  let added = 0;
  for (const region of regions) {
    const sweep = await trackIn(ctx, yahooSource(ctx, 'past-dates'),
      () => ctx.yahooCalendar(region, addDaysEurope(ctx, today, -400), addDaysEurope(ctx, today, -1)));
    if (!sweep) continue;
    added += upsertEuropePastDates(ctx.db, sweep.rows
      .filter((r) => r.date < today && mine.has(r.symbol))
      .map((r) => ({ symbol: r.symbol, date: r.date, timing: r.timeType === 'TAS' && r.timing !== 'UNKNOWN' ? r.timing : null })));
    if (!sweep.complete) {
      recordSourceError(ctx.db, yahooSource(ctx, 'past-dates'), `past-dates sweep (${region}) incomplete: ${sweep.rows.length} rows read`, ctx.now());
    }
  }
  return added;
}
