import type { DatabaseSync } from 'node:sqlite';
import { DelayedPrices, type DelayedMarket, type DelayedPricesDeps } from '../../live/delayedPrices.js';
import type { JpLivePriceDto, JpMarketDto } from '../api/types.js';
import { jpReportsBetween } from '../db/jpRepo.js';
import { isJpTradingDay, JST } from '../domain/jpCalendar.js';
import type { YahooQuote } from '../sources/yahooJp.js';
import { JP_INDICES, yahooJpSymbol } from '../universe.js';

/** Ruling 17: stocks every 60 s during 08:45–15:45 JST on TSE trading days, otherwise every 15 min. */
const JP_MARKET: DelayedMarket = {
  market: 'JP',
  zone: JST,
  isTradingDay: isJpTradingDay,
  sessionFromMin: 8 * 60 + 45,
  sessionToMin: 15 * 60 + 45,
  symbolOf: yahooJpSymbol,
  indices: JP_INDICES,
  failoverNames: { prices: 'yahoo-jp-prices', indices: 'yahoo-jp-indices' },
  reportingCodes: (db, from, to) => jpReportsBetween(db, from, to).map((r) => r.code),
};

/** The batch-quote answer in the poller's shape: only quotes with a price, a previous close and a time. */
export function toDelayedQuotes(m: Map<string, YahooQuote>): Map<string, { price: number; prevClose: number; time: number }> {
  const out = new Map<string, { price: number; prevClose: number; time: number }>();
  for (const [symbol, q] of m) {
    if (q.price != null && q.prevClose != null && q.time != null) out.set(symbol, { price: q.price, prevClose: q.prevClose, time: q.time });
  }
  return out;
}

/**
 * Delayed Yahoo `.T` prices ("Delayed ~20 min") for the codes someone sees, watches or that report today / tomorrow
 * (JST), by batch quotes of 50, and the Nikkei 225 / TOPIX ETF levels. A failed batch keeps the last values; a code
 * Yahoo does not quote stays blank. Only changed prices are published.
 */
export class JpPrices extends DelayedPrices {
  constructor(
    db: DatabaseSync,
    deps: DelayedPricesDeps,
    publishPrices: (p: Record<string, JpLivePriceDto>) => void,
    publishIndices: (m: JpMarketDto[]) => void,
    now: () => number = Date.now,
  ) {
    super(JP_MARKET, db, deps, publishPrices, publishIndices, now);
  }
}
