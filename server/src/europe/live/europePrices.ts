import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import { DelayedPrices, type DelayedMarket, type DelayedPriceDto } from '../../live/delayedPrices.js';
import type { IndexQuote } from '../../sources/yahoo.js';
import { allWatched } from '../../watchlist/store.js';
import type { EuropeLivePriceDto, EuropeMarketDto } from '../api/types.js';
import { europeReportsBetween, storedBankHolidays } from '../db/europeRepo.js';
import { calendarFor } from '../domain/calendars.js';
import { EXCHANGES, exchangeOfSymbol, exchangesOf, type EuropeMarket } from '../exchanges.js';
import type { TradegateQuote, TradegateState } from '../sources/tradegate.js';
import type { EuropeQuote } from '../sources/yahooEurope.js';
import { EUROPE_INDICES } from '../sources/yahooEurope.js';
import { tradegatePriceTime } from './tradegatePoller.js';

/** A Tradegate quote older than this is not served (the Yahoo price is). */
const TRADEGATE_MAX_AGE_MS = 24 * 3_600_000;

const LONDON = 'Europe/London';
const PARIS = 'Europe/Paris';

/** Ruling 14's Yahoo session window: UK 07:45–16:45 London on LSE days; EU 08:45–18:45 Paris on any EU trading day. */
function delayedMarket(market: EuropeMarket, db: DatabaseSync): DelayedMarket {
  const reporting = (d: DatabaseSync, from: string, to: string) => europeReportsBetween(d, market, from, to).map((r) => r.symbol);
  if (market === 'UK') {
    return {
      market, zone: LONDON,
      isTradingDay: (d) => calendarFor('LSE', storedBankHolidays(db)).isTradingDay(d),
      sessionFromMin: 7 * 60 + 45, sessionToMin: 16 * 60 + 45,
      symbolOf: (s) => s, indices: EUROPE_INDICES.UK,
      failoverNames: { prices: 'yahoo-uk-prices', indices: 'yahoo-uk-indices' },
      reportingCodes: reporting,
    };
  }
  return {
    market, zone: PARIS,
    isTradingDay: (d) => exchangesOf('EU').some((ex) => calendarFor(ex).isTradingDay(d)),
    sessionFromMin: 8 * 60 + 45, sessionToMin: 18 * 60 + 45,
    symbolOf: (s) => s, indices: EUROPE_INDICES.EU,
    failoverNames: { prices: 'yahoo-eu-prices', indices: 'yahoo-eu-indices' },
    reportingCodes: reporting,
  };
}

export interface EuropePricesDeps {
  /** Yahoo batch quotes (50 per request) keyed by Yahoo symbol; unquoted symbols absent. */
  quotes(symbols: string[]): Promise<Map<string, EuropeQuote>>;
  index(yahooSymbol: string): Promise<IndexQuote>;
}

/** What the prices need from the one shared Tradegate poller and its client. */
export interface TradegateSide {
  snapshot(): Record<string, TradegateQuote>;
  state(): TradegateState;
}

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * UK or Europe live prices, keyed by Yahoo symbol (`AZN.L`, `SAP.DE`), in `EuropeLivePriceDto`:
 * - `venue: 'tradegate'`, `currency: 'EUR'`: when the Tradegate client is `on` and the symbol's ISIN has a Tradegate
 *   quote younger than 24 h. Price is Tradegate's last (else its close), the change is from that one answer
 *   (last vs close), never against Yahoo's previous close. Outside 08:00–22:00 Berlin the price is the last session's
 *   close and `at` is that close's time.
 * - Otherwise `venue: 'yahoo'` with the currency Yahoo states (`GBp` stays pence): the shared `DelayedPrices` poller
 *   (batch quotes, 60 s in the Ruling 14 session window, 15 min outside it), "Delayed ~15 min".
 * Index levels come from Yahoo (`EUROPE_INDICES`).
 */
export class EuropePrices {
  private readonly delayed: DelayedPrices;
  private readonly yahoo = new Map<string, DelayedPriceDto>();
  private readonly currency = new Map<string, string | null>();

  constructor(
    private readonly market: EuropeMarket,
    private readonly db: DatabaseSync,
    deps: EuropePricesDeps,
    private readonly tradegate: TradegateSide | null,
    private readonly publishPrices: (p: Record<string, EuropeLivePriceDto>) => void,
    publishIndices: (m: EuropeMarketDto[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    const quotes = async (symbols: string[]) => {
      const got = await deps.quotes(symbols);
      const out = new Map<string, { price: number; prevClose: number; time: number }>();
      for (const [symbol, q] of got) {
        if (q.price == null || q.prevClose == null || q.time == null) continue;
        this.currency.set(symbol, q.currency);
        out.set(symbol, { price: q.price, prevClose: q.prevClose, time: q.time });
      }
      return out;
    };
    this.delayed = new DelayedPrices(delayedMarket(market, db), db, {
      quotes,
      quote: async (s) => {
        const q = (await quotes([s])).get(s);
        if (!q) throw new Error(`no Yahoo quote for ${s}`);
        return q;
      },
      index: deps.index,
    }, (changed) => {
      const out: Record<string, EuropeLivePriceDto> = {};
      for (const [symbol, p] of Object.entries(changed)) {
        this.yahoo.set(symbol, p);
        const live = this.priceOf(symbol);
        // A symbol served by Tradegate does not change on screen when its Yahoo quote does.
        if (live && live.venue === 'yahoo') out[symbol] = live;
      }
      if (Object.keys(out).length > 0) this.publishPrices(out);
    }, publishIndices, now);
  }

  start(): void { this.delayed.start(); }
  stop(): void { this.delayed.stop(); }
  setVisible(userId: string, symbols: string[]): void { this.delayed.setVisible(userId, symbols); }
  visibleCodes(): string[] { return this.delayed.visibleCodes(); }
  refresh(): void { this.delayed.refresh(); }
  /** One Yahoo poller tick (the 15 s timer calls it; tests too). */
  tick(): Promise<void> { return this.delayed.tick(); }
  indices(): EuropeMarketDto[] { return this.delayed.indices(); }

  private mine(symbol: string): boolean {
    const ex = exchangeOfSymbol(symbol);
    return ex != null && EXCHANGES[ex].market === this.market;
  }

  private tradegateLive(q: TradegateQuote | undefined): EuropeLivePriceDto | null {
    if (!q || !this.tradegate || this.tradegate.state() !== 'on') return null;
    const at = Date.parse(q.at);
    if (!Number.isFinite(at) || this.now() - at >= TRADEGATE_MAX_AGE_MS) return null;
    const price = q.last ?? q.close;
    if (price == null) return null;
    return { price, prevClose: q.close, changePct: round2(q.changePct), at: tradegatePriceTime(q.at), currency: 'EUR', venue: 'tradegate' };
  }

  private yahooLive(symbol: string): EuropeLivePriceDto | null {
    const p = this.yahoo.get(symbol);
    return p ? { ...p, currency: this.currency.get(symbol) ?? null, venue: 'yahoo' } : null;
  }

  private priceOf(symbol: string, tg = this.tradegate?.snapshot()): EuropeLivePriceDto | null {
    return this.tradegateLive(tg?.[symbol]) ?? this.yahooLive(symbol);
  }

  /** Every symbol of this market with a price: Tradegate when live, else Yahoo. */
  snapshot(): Record<string, EuropeLivePriceDto> {
    const tg = this.tradegate?.snapshot() ?? {};
    const out: Record<string, EuropeLivePriceDto> = {};
    for (const symbol of new Set([...this.yahoo.keys(), ...Object.keys(tg)])) {
      if (!this.mine(symbol)) continue;
      const p = this.priceOf(symbol, tg);
      if (p) out[symbol] = p;
    }
    return out;
  }

  /** Fresh Tradegate quotes from the shared poller: this market's symbols are published. */
  onTradegate(changed: Record<string, TradegateQuote>): void {
    const out: Record<string, EuropeLivePriceDto> = {};
    for (const [symbol, q] of Object.entries(changed)) {
      if (!this.mine(symbol)) continue;
      const p = this.tradegateLive(q);
      if (p) out[symbol] = p;
    }
    if (Object.keys(out).length > 0) this.publishPrices(out);
  }

  /** The symbols the Tradegate poller should cover for this market (visible ∪ watched ∪ reporting today/tomorrow), with their ISIN. */
  tradegateWanted(): { isin: string; symbol: string }[] {
    const symbols = new Set<string>(this.visibleCodes());
    for (const s of allWatched(this.db, this.market)) symbols.add(s);
    const today = DateTime.fromMillis(this.now(), { zone: this.market === 'UK' ? LONDON : PARIS });
    for (const r of europeReportsBetween(this.db, this.market, today.toISODate()!, today.plus({ days: 1 }).toISODate()!)) symbols.add(r.symbol);
    if (symbols.size === 0) return [];
    const isins = new Map((this.db.prepare('SELECT symbol, isin FROM europe_stocks WHERE market = ? AND isin IS NOT NULL')
      .all(this.market) as { symbol: string; isin: string }[]).map((r) => [r.symbol, r.isin]));
    return [...symbols].sort().flatMap((symbol) => {
      const isin = isins.get(symbol);
      return isin ? [{ isin, symbol }] : [];
    });
  }
}
