import { type Db, liveSymbols } from '../db/repo.js';
import { nextTradingDay } from '../domain/marketCalendar.js';
import { type LivePrice, PriceBook } from '../domain/priceBook.js';
import { FinnhubStream, parseQuote, todaysReference } from '../sources/finnhubStream.js';
import type { Http } from '../sources/http.js';

/** Finnhub's free real-time stream allows 50 symbols per connection. */
const MAX_SYMBOLS = 50;
const REFRESH_MS = 5 * 60_000;
const PUSH_MS = 1000;

/**
 * Real-time prices for the reporters that matter now (today + next session): the Finnhub trade stream,
 * seeded and given a previous close by one quote call per symbol per day. Changes are pushed at most once a second.
 */
export class LivePrices {
  readonly book = new PriceBook();
  private stream: FinnhubStream;
  private symbols: string[] = [];
  private quotedOn = new Map<string, string>(); // symbol -> date its quote was fetched
  private pending = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly db: Db,
    token: string,
    private readonly http: Http,
    private readonly today: () => string,
    private readonly publish: (prices: Record<string, LivePrice>) => void,
  ) {
    this.stream = new FinnhubStream(token, (trades) => {
      for (const s of this.book.applyTrades(trades)) this.pending.add(s);
    });
  }

  start(): void {
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), REFRESH_MS));
    this.timers.push(setInterval(() => this.flush(), PUSH_MS));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.stream.stop();
  }

  snapshot(): Record<string, LivePrice> {
    return this.book.snapshot(this.symbols);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const changed = this.book.snapshot(this.pending);
    this.pending.clear();
    this.publish(changed);
  }

  private async refresh(): Promise<void> {
    const today = this.today();
    let next = today;
    try { next = nextTradingDay(today); } catch { /* calendar not covering: today only */ }
    this.symbols = liveSymbols(this.db, today, next, MAX_SYMBOLS);
    this.stream.setSymbols(this.symbols);
    for (const s of this.symbols) {
      if (this.quotedOn.get(s) === today) continue;
      try {
        const q = parseQuote(await this.http.json(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s.replace('/', '.'))}`));
        if (q) { this.book.setQuote(s, todaysReference(q, today)); this.pending.add(s); }
        this.quotedOn.set(s, today);
      } catch (err) {
        console.error(`[prices] quote ${s}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
