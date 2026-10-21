import { type Db, liveSymbols } from '../db/repo.js';
import { nextTradingDay } from '../domain/marketCalendar.js';
import { type LivePrice, PriceBook, type PriceSource, type Trade } from '../domain/priceBook.js';
import { createFailover } from '../sources/failover.js';
import { FinnhubStream, parseQuote, todaysReference } from '../sources/finnhubStream.js';
import type { Http } from '../sources/http.js';
import { allWatched } from '../watchlist/store.js';

/** Finnhub's free real-time stream allows 50 symbols per connection. */
const MAX_SYMBOLS = 50;
/** Finnhub's free REST allows 60 calls a minute; seeds and polling share it. */
const QUOTES_PER_MINUTE = 60;
const REPICK_MS = 5000;
const QUOTE_MS = 1100;
const PUSH_MS = 1000;
const VISIBLE_TTL_MS = 2 * 60_000;

export interface Quote { price: number; prevClose: number; time: number }
interface StreamLike { setSymbols(symbols: string[]): void; stop(): void }

export interface LivePricesOptions {
  now?: () => number;
  /** US watchlist symbols across all users. */
  watched?: () => string[];
  /** Reporters for today and the next session. */
  reporters?: (today: string, next: string) => string[];
  makeStream?: (onTrades: (trades: Trade[]) => void) => StreamLike;
  /** Finnhub /quote; null when the symbol is unknown. Throws on failure. */
  finnhubQuote?: (symbol: string) => Promise<Quote | null>;
  /** Yahoo chart quote, used when Finnhub fails or blocks. */
  yahooQuote?: ((symbol: string) => Promise<Quote | null>) | undefined;
}

/**
 * Which symbols get the 50 stream slots and which are polled. Priority: watchlists, then what users
 * are looking at, then the day's reporters. Duplicates keep their first (highest) position.
 */
export function pickSlots(watch: string[], visible: string[], reporters: string[], max = MAX_SYMBOLS): { stream: string[]; poll: string[] } {
  const all = [...new Set([...watch, ...visible, ...reporters])];
  return { stream: all.slice(0, max), poll: all.slice(max) };
}

/**
 * Real-time prices for what matters now: the Finnhub trade stream for the top 50 symbols, the rest polled
 * round-robin through Finnhub /quote (sharing one 60/min budget with the daily seed quotes), Yahoo as backup.
 * Changes are pushed at most once a second.
 */
export class LivePrices {
  readonly book = new PriceBook();
  private stream: StreamLike;
  private symbols: string[] = [];
  private streamList: string[] = [];
  private pollList: string[] = [];
  private quotedOn = new Map<string, string>(); // symbol -> date its quote was fetched
  private visible = new Map<string, { symbols: string[]; at: number }>(); // user id -> what they see
  private failedAt = new Map<string, number>(); // symbol -> when both sources last failed
  private pending = new Set<string>();
  private callTimes: number[] = [];
  private rr = 0;
  private busy = false;
  private tradeCount = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly now: () => number;
  private readonly failover: ReturnType<typeof createFailover>;
  private readonly opts: LivePricesOptions;

  constructor(
    private readonly db: Db,
    token: string,
    private readonly http: Http,
    private readonly today: () => string,
    private readonly publish: (prices: Record<string, LivePrice>) => void,
    opts: LivePricesOptions = {},
  ) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.failover = createFailover(db, this.now);
    const onTrades = (trades: Trade[]) => {
      this.tradeCount += trades.length;
      for (const s of this.book.applyTrades(trades)) this.pending.add(s);
    };
    this.stream = opts.makeStream ? opts.makeStream(onTrades) : new FinnhubStream(token, onTrades);
  }

  start(): void {
    void this.repick();
    this.timers.push(setInterval(() => void this.repick(), REPICK_MS));
    this.timers.push(setInterval(() => void this.quoteOnce(), QUOTE_MS));
    this.timers.push(setInterval(() => this.flush(), PUSH_MS));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.stream.stop();
  }

  snapshot(): Record<string, LivePrice> {
    return this.book.snapshot(this.symbols);
  }

  /** What one signed-in user currently sees; counts for 2 minutes after the last call. */
  setVisible(userId: string, symbols: string[]): void {
    this.visible.set(userId, { symbols, at: this.now() });
  }

  private visibleUnion(): string[] {
    const out = new Set<string>();
    for (const [user, v] of this.visible) {
      if (this.now() - v.at >= VISIBLE_TTL_MS) { this.visible.delete(user); continue; }
      v.symbols.forEach((s) => out.add(s));
    }
    return [...out];
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const changed = this.book.snapshot(this.pending);
    this.pending.clear();
    this.publish(changed);
  }

  /** Re-picks the stream and poll lists; the stream is only told when its list actually changes. */
  async repick(): Promise<void> {
    const today = this.today();
    let next = today;
    try { next = nextTradingDay(today); } catch { /* calendar not covering: today only */ }
    let watch: string[] = [];
    let reporters: string[] = [];
    try {
      watch = (this.opts.watched ?? (() => allWatched(this.db, 'US')))();
      reporters = (this.opts.reporters ?? ((a, b) => liveSymbols(this.db, a, b, MAX_SYMBOLS)))(today, next);
    } catch (err) {
      console.error(`[prices] pick: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const { stream, poll } = pickSlots(watch, this.visibleUnion(), reporters, MAX_SYMBOLS);
    this.pollList = poll;
    this.symbols = [...stream, ...poll];
    if (stream.length !== this.streamList.length || stream.some((s, i) => s !== this.streamList[i])) {
      this.streamList = stream;
      console.log(`[prices] ${stream.length} streamed, ${poll.length} polled, ${this.tradeCount} trades since last change`);
      this.tradeCount = 0;
      this.stream.setSymbols(stream);
    }
  }

  private callsInLastMinute(): number {
    const cutoff = this.now() - 60_000;
    while (this.callTimes.length && this.callTimes[0]! <= cutoff) this.callTimes.shift();
    return this.callTimes.length;
  }

  private pickNextQuote(today: string): string | null {
    const unseeded = this.symbols.find((s) => this.quotedOn.get(s) !== today && this.now() - (this.failedAt.get(s) ?? -Infinity) >= 60_000);
    if (unseeded) return unseeded;
    if (this.pollList.length === 0) return null;
    return this.pollList[this.rr++ % this.pollList.length]!;
  }

  /** At most one quote: unseeded symbols first, then the polled ones round-robin. Respects the 60/min budget. */
  async quoteOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.callsInLastMinute() >= QUOTES_PER_MINUTE) return;
      const today = this.today();
      const symbol = this.pickNextQuote(today);
      if (!symbol) return;
      const finnhub = this.opts.finnhubQuote ?? (async (s: string) =>
        parseQuote(await this.http.json(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s.replace('/', '.'))}`)));
      const yahoo = this.opts.yahooQuote;
      try {
        const r = await this.failover<Quote | null>(
          { name: 'finnhub-quote', run: () => { this.callTimes.push(this.now()); return finnhub(symbol); } },
          yahoo ? { name: 'yahoo-quote', run: () => yahoo(symbol.replace('/', '-')) } : null,
        );
        if (!r) { this.failedAt.set(symbol, this.now()); return; } // both failed: retry in a minute
        this.failedAt.delete(symbol);
        this.quotedOn.set(symbol, today);
        if (r.value) {
          const source: PriceSource = r.via === 'backup' ? 'backup' : 'poll';
          if (this.book.setQuote(symbol, todaysReference(r.value, today), source)) this.pending.add(symbol);
        }
      } catch (err) {
        console.error(`[prices] quote ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
