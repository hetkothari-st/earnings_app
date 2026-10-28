import { sweepSixK } from '../../sources/sixKSweep.js';
import { europeSixKMarket } from '../live/europeSixK.js';
import type { EuropeJobContext } from './context.js';
import { addDaysEurope } from './estimates.js';

/** Filings this many days back are read: a results-date notice is often filed weeks ahead. */
const LOOK_BACK_DAYS = 45;

/**
 * Per-CIK submissions sweep, the backstop for the shared 6-K feed: every full-level stock of the market, with or
 * without a calendar row, 6-K filers and the 8-K filers (LOGI) alike (the feed reaches the latter only through the US
 * 8-K feed). Filings dated on or after local today-45 and not yet seen go through `handleEuropeFiling`, which looks
 * the stock's session up itself. Without the SEC client nothing runs. Returns the released and re-dated report ids.
 */
export async function sweepEuropeSec(ctx: EuropeJobContext): Promise<number[]> {
  const http = ctx.secHttp;
  if (!http) return [];
  const since = addDaysEurope(ctx, ctx.today(), -LOOK_BACK_DAYS);
  // The sweep's ids go to the scheduler's own hook, not to a live publisher.
  const market = europeSixKMarket(ctx, () => {});
  return sweepSixK(ctx, http, { ...market, ciks: () => new Set([...market.ciks(), ...market.eightKCiks()]) }, since);
}
