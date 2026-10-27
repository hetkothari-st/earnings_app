import { DateTime } from 'luxon';
import type { DatabaseSync } from 'node:sqlite';
import { blockAware, createFailover } from '../../sources/failover.js';
import type { IndexQuote } from '../../sources/yahoo.js';
import { allWatched } from '../../watchlist/store.js';
import type { HkLivePriceDto, HkMarketDto } from '../api/types.js';
import { hkReportsBetween } from '../db/hkRepo.js';
import { addDaysHKT, HKT, isHkTradingDay } from '../domain/hkCalendar.js';
import { HK_INDICES, yahooHkSymbol } from '../universe.js';

const TICK_MS = 15_000;
/** Ruling 12: stocks every 60 s during 09:15–16:30 HKT on HK trading days, otherwise every 15 min. */
const SESSION_EVERY_MS = 60_000;
const OFF_SESSION_EVERY_MS = 15 * 60_000;
const VISIBLE_TTL_MS = 2 * 60_000;
/** A code Yahoo has no quote for is asked again at most this often between full rounds. */
const MISSING_RETRY_MS = 60_000;

export interface HkPricesDeps {
  quote: (yahooSymbol: string) => Promise<{ price: number; prevClose: number; time: number }>;
  index: (yahooSymbol: string) => Promise<IndexQuote>;
}

const changePct = (price: number, prev: number | null) => (prev && prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null);

/**
 * Delayed Yahoo `.HK` prices for the codes someone sees, watches or that report today / tomorrow (HKT), and the
 * HK index levels. A failed quote keeps the last value. Only changed prices are published.
 */
export class HkPrices {
  private visible = new Map<string, { codes: string[]; at: number }>();
  private prices = new Map<string, HkLivePriceDto>();
  private idx = new Map<string, HkMarketDto>();
  private tried = new Map<string, number>();
  private lastStocks = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private ticking = false;
  private readonly failover: ReturnType<typeof createFailover>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: HkPricesDeps,
    private readonly publishPrices: (p: Record<string, HkLivePriceDto>) => void,
    private readonly publishIndices: (m: HkMarketDto[]) => void,
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

  /** The HK codes a signed-in user currently sees; forgotten after 2 minutes without an update. */
  setVisible(userId: string, codes: string[]): void {
    this.visible.set(userId, { codes, at: this.now() });
  }

  /** Re-pick the codes (a watch was added, a page opened) and poll them now. */
  refresh(): void {
    void this.pollStocks().catch((e) => console.warn('hk prices refresh:', e instanceof Error ? e.message : e));
  }

  snapshot(): Record<string, HkLivePriceDto> {
    return Object.fromEntries(this.prices);
  }

  /** Index levels in HK_INDICES order; empty until one is known (the markets route then asks Yahoo itself). */
  indices(): HkMarketDto[] {
    if (this.idx.size === 0) return [];
    return HK_INDICES.map((i) => this.idx.get(i.name) ?? { index: i.name, price: null, changePct: null, asOf: null });
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
    const t = DateTime.fromMillis(this.now(), { zone: HKT });
    const hhmm = t.hour * 60 + t.minute;
    return isHkTradingDay(t.toISODate()!) && hhmm >= 9 * 60 + 15 && hhmm <= 16 * 60 + 30;
  }

  private codes(): string[] {
    const now = this.now();
    const out = new Set<string>();
    for (const [user, v] of this.visible) {
      if (now - v.at >= VISIBLE_TTL_MS) { this.visible.delete(user); continue; }
      for (const c of v.codes) out.add(c);
    }
    for (const c of allWatched(this.db, 'HK')) out.add(c);
    const today = DateTime.fromMillis(now, { zone: HKT }).toISODate()!;
    for (const r of hkReportsBetween(this.db, today, addDaysHKT(today, 1))) out.add(r.code);
    return [...out].sort();
  }

  /** All current codes (a full round), or only `only` (codes still without a price). */
  private async pollStocks(only?: string[]): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!only) this.lastStocks = this.now();
      const changed: Record<string, HkLivePriceDto> = {};
      for (const code of only ?? this.codes()) {
        this.tried.set(code, this.now());
        const q = (await this.failover({ name: 'yahoo-hk-prices', run: () => blockAware('yahoo-hk-prices', () => this.deps.quote(yahooHkSymbol(code))) }, null))?.value;
        if (!q) continue; // keep the last value
        const next: HkLivePriceDto = { price: q.price, prevClose: q.prevClose, changePct: changePct(q.price, q.prevClose), at: new Date(q.time).toISOString() };
        const prev = this.prices.get(code);
        if (prev && prev.price === next.price && prev.prevClose === next.prevClose) continue;
        this.prices.set(code, next);
        changed[code] = next;
      }
      if (Object.keys(changed).length > 0) this.publishPrices(changed);
    } finally {
      this.polling = false;
    }
  }

  private async pollIndices(): Promise<void> {
    let changed = false;
    for (const i of HK_INDICES) {
      const q = (await this.failover({ name: 'yahoo-hk-indices', run: () => blockAware('yahoo-hk-indices', () => this.deps.index(i.yahoo)) }, null))?.value;
      if (!q) continue; // keep the last value
      const next: HkMarketDto = { index: i.name, price: q.price, changePct: q.changePct, asOf: q.asOf };
      const prev = this.idx.get(i.name);
      if (prev && prev.price === next.price && prev.changePct === next.changePct && prev.asOf === next.asOf) continue;
      this.idx.set(i.name, next);
      changed = true;
    }
    if (changed) this.publishIndices(this.indices());
  }
}
