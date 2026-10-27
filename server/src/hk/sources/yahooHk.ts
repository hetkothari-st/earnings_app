import { fetchYahooPastDatesFor, type YahooPastDate } from '../../india/sources/yahooPastDates.js';
import { createQuoteSummaryFetcher } from '../../sources/yahooEarnings.js';
import { parseYahooSummaryFor, type YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import { yahooLimiter } from '../../sources/yahooLimiter.js';
import { HKT, hkTimingFromHkt } from '../domain/hkCalendar.js';

/** What Yahoo knows about one `.HK` stock. Currencies are kept as Yahoo states them (never converted). */
export type YahooHkSummary = YahooForeignSummary;

export function parseYahooHkSummary(json: unknown): YahooHkSummary {
  return parseYahooSummaryFor(json, { zone: HKT, capCurrency: 'HKD' });
}

/**
 * One summary per code per `ttlMs` (default 25 min), shared by the calendar and estimates jobs. Failures are not
 * cached. Requests wait for the cross-market Yahoo budget (`yahooLimiter`).
 */
export function createYahooHkFetcher(ttlMs = 25 * 60_000): (yahooSymbol: string) => Promise<YahooHkSummary | null> {
  const get = createQuoteSummaryFetcher('price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings', parseYahooHkSummary, { limiter: yahooLimiter });
  const cache = new Map<string, { at: number; value: YahooHkSummary | null }>();
  return async (yahooSymbol) => {
    const hit = cache.get(yahooSymbol);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await get(yahooSymbol);
    cache.set(yahooSymbol, { at: Date.now(), value });
    return value;
  };
}

/** Past result dates (newest first) of a `.HK` code, HKT date and timing. */
export function yahooHkPastDates(yahooSymbol: string): Promise<YahooPastDate[]> {
  return fetchYahooPastDatesFor(yahooSymbol, HKT, hkTimingFromHkt);
}
