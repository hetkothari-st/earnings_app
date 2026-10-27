import { sweepSixK } from '../../sources/sixKSweep.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { hkSixKMarket } from '../live/hkSecWatch.js';
import type { HkJobContext } from './context.js';

/** Filings this many days back are read: a results-date notice is often filed a month ahead. */
const LOOK_BACK_DAYS = 45;

/**
 * Per-CIK submissions sweep (Ruling 11), the backstop for the 6-K feed: every full-level stock, with or without a
 * calendar row. Filings dated on or after today-45 (HKT; a date notice can come weeks before the results) and not
 * yet seen get the acceptance time
 * (ET wall clock in the SEC header) and go through `handleHkFiling`. Without the SEC client nothing runs.
 * Returns the released and re-dated report ids.
 */
export async function sweepHkSec(ctx: HkJobContext): Promise<number[]> {
  const http = ctx.secHttp;
  if (!http) return [];
  const since = addDaysHKT(ctx.todayHKT(), -LOOK_BACK_DAYS);
  // The sweep's ids go to the scheduler's own hook, not to a live publisher.
  return sweepSixK(ctx, http, hkSixKMarket(ctx, () => {}), since);
}
