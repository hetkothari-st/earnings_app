import type { DatabaseSync } from 'node:sqlite';
import { DelayedPrices, type DelayedMarket, type DelayedPricesDeps } from '../../live/delayedPrices.js';
import type { HkLivePriceDto, HkMarketDto } from '../api/types.js';
import { hkReportsBetween } from '../db/hkRepo.js';
import { HKT, isHkTradingDay } from '../domain/hkCalendar.js';
import { HK_INDICES, yahooHkSymbol } from '../universe.js';

export type HkPricesDeps = Pick<DelayedPricesDeps, 'quote' | 'index'>;

/** Ruling 12: stocks every 60 s during 09:15–16:30 HKT on HK trading days, otherwise every 15 min. */
const HK_MARKET: DelayedMarket = {
  market: 'HK',
  zone: HKT,
  isTradingDay: isHkTradingDay,
  sessionFromMin: 9 * 60 + 15,
  sessionToMin: 16 * 60 + 30,
  symbolOf: yahooHkSymbol,
  indices: HK_INDICES,
  failoverNames: { prices: 'yahoo-hk-prices', indices: 'yahoo-hk-indices' },
  reportingCodes: (db, from, to) => hkReportsBetween(db, from, to).map((r) => r.code),
};

/**
 * Delayed Yahoo `.HK` prices for the codes someone sees, watches or that report today / tomorrow (HKT), and the
 * HK index levels (the shared `DelayedPrices` poller, one quote per code). A failed quote keeps the last value.
 * Only changed prices are published.
 */
export class HkPrices extends DelayedPrices {
  constructor(
    db: DatabaseSync,
    deps: HkPricesDeps,
    publishPrices: (p: Record<string, HkLivePriceDto>) => void,
    publishIndices: (m: HkMarketDto[]) => void,
    now: () => number = Date.now,
  ) {
    super(HK_MARKET, db, { quote: deps.quote, index: deps.index }, publishPrices, publishIndices, now);
  }
}
