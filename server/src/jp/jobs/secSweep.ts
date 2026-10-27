import { sweepSixK } from '../../sources/sixKSweep.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { jpSixKMarket } from '../live/jpSixK.js';
import type { JpJobContext } from './context.js';

/** Filings this many days back are read: a results-date notice is often filed weeks ahead. */
const LOOK_BACK_DAYS = 45;

/**
 * Per-CIK submissions sweep, the backstop for the shared 6-K feed: every full-level Japan stock, with or without a
 * calendar row. Filings dated on or after JST today-45 and not yet seen get the acceptance time and go through
 * `handleJpFiling`. Without the SEC client nothing runs. Returns the released and re-dated report ids.
 */
export async function sweepJpSec(ctx: JpJobContext): Promise<number[]> {
  const http = ctx.secHttp;
  if (!http) return [];
  const since = addDaysJST(ctx.todayJST(), -LOOK_BACK_DAYS);
  // The sweep's ids go to the scheduler's own hook, not to a live publisher.
  return sweepSixK(ctx, http, jpSixKMarket(ctx, () => {}), since);
}
