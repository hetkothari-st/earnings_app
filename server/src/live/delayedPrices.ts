import { DateTime } from 'luxon';
import type { DatabaseSync } from 'node:sqlite';
import { blockAware, createFailover } from '../sources/failover.js';
import type { IndexQuote } from '../sources/yahoo.js';
import { allWatched } from '../watchlist/store.js';

const TICK_MS = 15_000;
/** Stocks every 60 s during the market's session on its trading days, otherwise every 15 min. */
const SESSION_EVERY_MS = 60_000;
const OFF_SESSION_EVERY_MS = 15 * 60_000;
const VISIBLE_TTL_MS = 2 * 60_000;
/** A code Yahoo has no quote for is asked again at most this often between full rounds. */
const MISSING_RETRY_MS = 60_000;
/** Symbols per batch-quote request. */
const QUOTE_BATCH = 50;

export interface DelayedPriceDto { price: number; prevClose: number | null; changePct: number | null; at: string }
export interface DelayedIndexDto { index: string; price: number | null; changePct: number | null; asOf: string | null }

type Quote = { price: number; prevClose: number; time: number };

export interface DelayedPricesDeps {
  quote: (yahooSymbol: string) => Promise<Quote>;
  index: (yahooSymbol: string) => Promise<IndexQuote>;
  /** Batch quotes keyed by Yahoo symbol (unquoted symbols absent). When present, stock rounds use it, 50 symbols per call. */
  quotes?: (yahooSymbols: string[]) => Promise<Map<string, Quote>>;
}

/** What differs between the markets polled this way (HK, Japan). */
export interface DelayedMarket {
  market: 'HK' | 'JP';
  zone: string;
  isTradingDay(d: string): boolean;
  /** Session window, minutes from local midnight, inclusive. */
  sessionFromMin: number;
  sessionToMin: number;
  symbolOf(code: string): string;
  indices: readonly { name: string; yahoo: string }[];
  failoverNames: { prices: string; indices: string };
  /** Codes with a report dated `from`..`to` (local today and tomorrow). */
  reportingCodes(db: DatabaseSync, from: string, to: string): string[];
}

const changePct = (price: number, prev: number | null) => (prev && prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null);

/**
 * Delayed Yahoo prices for the codes someone sees, watches or that report today / tomorrow (local), and the
 * market's index levels. A failed quote keeps the last value. Only changed prices are published. A code with no
 * price yet is fetched at the next 15 s tick, not at the next round.
 */
export class DelayedPrices {
  private visible = new Map<string, { codes: string[]; at: number }>();
  private prices = new Map<string, DelayedPriceDto>();
  private idx = new Map<string, DelayedIndexDto>();
  private tried = new Map<string, number>();
  private lastStocks = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private ticking = false;
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly m: DelayedMarket,
    private readonly db: DatabaseSync,
    private readonly deps: DelayedPricesDeps,
    private readonly publishPrices: (p: Record<string, DelayedPriceDto>) => void,
    private readonly publishIndices: (m: DelayedIndexDto[]) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.failover = createFailover(db, now);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The codes a signed-in user currently sees; forgotten after 2 minutes without an update. */
  setVisible(userId: string, codes: string[]): void {
    this.visible.set(userId, { codes, at: this.now() });
  }

  /** Codes some signed-in user saw within the last 2 minutes. */
  visibleCodes(): string[] {
    const now = this.now();
    const out = new Set<string>();
    for (const [user, v] of this.visible) {
      if (now - v.at >= VISIBLE_TTL_MS) { this.visible.delete(user); continue; }
      for (const c of v.codes) out.add(c);
    }
    return [...out].sort();
  }

  /** Re-pick the codes (a watch was added, a page opened) and poll them now. */
  refresh(): void {
    void this.pollStocks().catch((e) => console.warn(`${this.m.market.toLowerCase()} prices refresh:`, e instanceof Error ? e.message : e));
  }

  snapshot(): Record<string, DelayedPriceDto> {
    return Object.fromEntries(this.prices);
  }

  /** Index levels in the market's index order; empty until one is known (the markets route then asks Yahoo itself). */
  indices(): DelayedIndexDto[] {
    if (this.idx.size === 0) return [];
    return this.m.indices.map((i) => this.idx.get(i.name) ?? ({ index: i.name, price: null, changePct: null, asOf: null }));
  }

  /** Every 15 s: indices every tick in session; stocks once per 60 s in session, every 15 min outside it. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const session = this.inSession();
      const stocksDue = this.now() - this.lastStocks >= (session ? SESSION_EVERY_MS : OFF_SESSION_EVERY_MS);
      if (session || stocksDue) await this.pollIndices();
      if (stocksDue) await this.pollStocks();
      else {
        // A code with no price yet (just opened, rows created after start) is fetched now, not at the next round.
        const missing = this.codes().filter((c) => !this.prices.has(c) && this.now() - (this.tried.get(c) ?? -Infinity) >= MISSING_RETRY_MS);
        if (missing.length > 0) await this.pollStocks(missing);
      }
    } finally {
      this.ticking = false;
    }
  }

  private inSession(): boolean {
    const t = DateTime.fromMillis(this.now(), { zone: this.m.zone });
    const hhmm = t.hour * 60 + t.minute;
    return this.m.isTradingDay(t.toISODate()!) && hhmm >= this.m.sessionFromMin && hhmm <= this.m.sessionToMin;
  }

  private codes(): string[] {
    const out = new Set<string>(this.visibleCodes());
    for (const c of allWatched(this.db, this.m.market)) out.add(c);
    const today = DateTime.fromMillis(this.now(), { zone: this.m.zone });
    for (const c of this.m.reportingCodes(this.db, today.toISODate()!, today.plus({ days: 1 }).toISODate()!)) out.add(c);
    return [...out].sort();
  }

  /** Stores a fresh quote and adds it to `changed` when it differs from the last one. */
  private store(code: string, q: Quote, changed: Record<string, DelayedPriceDto>): void {
    const next = { price: q.price, prevClose: q.prevClose, changePct: changePct(q.price, q.prevClose), at: new Date(q.time).toISOString() };
    const prev = this.prices.get(code);
    if (prev && prev.price === next.price && prev.prevClose === next.prevClose) return;
    this.prices.set(code, next);
    changed[code] = next;
  }

  /** All current codes (a full round), or only `only` (codes still without a price). */
  private async pollStocks(only?: string[]): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!only) this.lastStocks = this.now();
      const name = this.m.failoverNames.prices;
      const changed: Record<string, DelayedPriceDto> = {};
      const codes = only ?? this.codes();
      const batch = this.deps.quotes;
      if (batch) {
        for (let i = 0; i < codes.length; i += QUOTE_BATCH) {
          const chunk = codes.slice(i, i + QUOTE_BATCH);
          for (const code of chunk) this.tried.set(code, this.now());
          const symbols = chunk.map((c) => this.m.symbolOf(c));
          const got = (await this.failover({ name, run: () => blockAware(name, () => batch(symbols)) }, null))?.value;
          if (!got) continue; // keep the last values
          for (const code of chunk) {
            const q = got.get(this.m.symbolOf(code));
            if (q) this.store(code, q, changed); // unquoted: keep the last value
          }
        }
      } else {
        for (const code of codes) {
          this.tried.set(code, this.now());
          const q = (await this.failover({ name, run: () => blockAware(name, () => this.deps.quote(this.m.symbolOf(code))) }, null))?.value;
          if (q) this.store(code, q, changed); // else keep the last value
        }
      }
      if (Object.keys(changed).length > 0) this.publishPrices(changed);
    } finally {
      this.polling = false;
    }
  }

  private async pollIndices(): Promise<void> {
    const name = this.m.failoverNames.indices;
    let changed = false;
    for (const i of this.m.indices) {
      const q = (await this.failover({ name, run: () => blockAware(name, () => this.deps.index(i.yahoo)) }, null))?.value;
      if (!q) continue; // keep the last value
      const next = { index: i.name, price: q.price, changePct: q.changePct, asOf: q.asOf };
      const prev = this.idx.get(i.name);
      if (prev && prev.price === next.price && prev.changePct === next.changePct && prev.asOf === next.asOf) continue;
      this.idx.set(i.name, next);
      changed = true;
    }
    if (changed) this.publishIndices(this.indices());
  }
}
