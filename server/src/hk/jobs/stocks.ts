import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import { addDaysHKT, holidaysUnknownHk } from '../domain/hkCalendar.js';
import { hkStocks, setHkProfile, syncHkUniverse } from '../db/hkRepo.js';
import { HK_UNIVERSE } from '../universe.js';
import { guardedIn, type HkJobContext } from './context.js';

/** A `hk-holidays` status warning while the holiday list does not reach 60 days ahead. */
export function checkHkHolidayCoverage(ctx: HkJobContext): void {
  if (holidaysUnknownHk(addDaysHKT(ctx.todayHKT(), 60))) {
    recordSourceError(ctx.db, 'hk-holidays', 'HK holiday list for 2028 not added yet: weekends only', ctx.now());
  } else {
    recordSourceSuccess(ctx.db, 'hk-holidays', ctx.now());
  }
}

/** The universe, then name / sector / market cap from Yahoo (a missing value never blanks a stored one). */
export async function refreshHkStocks(ctx: HkJobContext): Promise<void> {
  syncHkUniverse(ctx.db, HK_UNIVERSE, ctx.now());
  for (const stock of hkStocks(ctx.db).filter((s) => s.active)) {
    const y = (await guardedIn(ctx, { name: 'yahoo-hk', run: () => ctx.yahoo(stock.yahooSymbol) }))?.value;
    if (!y) continue;
    setHkProfile(ctx.db, stock.code,
      { name: y.name, sector: y.sector, industry: y.industry, marketCap: y.marketCap, asOf: y.marketCapAsOf }, ctx.now());
  }
  checkHkHolidayCoverage(ctx);
}
