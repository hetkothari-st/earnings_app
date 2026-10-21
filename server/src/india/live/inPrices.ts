import type { DatabaseSync } from 'node:sqlite';
import { activeStocks, listInRange } from '../db/inRepo.js';
import { addDaysIST, nextNseTradingDay } from '../domain/nseCalendar.js';
import type { KiteSession } from '../sources/kiteLogin.js';
import { KiteStream, type KiteTick } from '../sources/kiteStream.js';

export interface InLivePrice { price: number; prevClose: number | null; changePct: number | null; at: string }

/** Index tokens on Kite (segment byte 9 = index). */
export const IN_INDICES: { name: string; token: number; yahoo: string }[] = [
  { name: 'NIFTY 50', token: 256265, yahoo: '^NSEI' },
  { name: 'SENSEX', token: 265, yahoo: '^BSESN' },
  { name: 'NIFTY BANK', token: 260105, yahoo: '^NSEBANK' },
  { name: 'NIFTY MIDCAP 100', token: 256777, yahoo: 'NIFTY_MIDCAP_100.NS' },
];

const PUSH_EVERY_MS = 1_000;
const RESUBSCRIBE_EVERY_MS = 5 * 60_000;

const changePct = (price: number, prev: number | null) => (prev && prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null);

/**
 * Real-time prices for today's and the next session's India reporters, plus the four indices,
 * from the Kite ticker. Changes are pushed at most once a second. Without a session nothing streams.
 */
export class InPrices {
  private stream: KiteStream | null = null;
  private ticks = new Map<number, KiteTick & { at: number }>();
  private symbolOf = new Map<number, string>();
  private pending = new Set<string>();
  private pushTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly session: () => KiteSession | null,
    private readonly today: () => string,
    private readonly onPrices: (prices: Record<string, InLivePrice>) => void,
  ) {}

  start(): void {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), RESUBSCRIBE_EVERY_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.stream?.disconnect();
    this.stream = null;
  }

  /** Re-pick the stocks to watch (the reporters change through the day) and connect if needed. */
  refresh(): void {
    const today = this.today();
    const until = nextNseTradingDay(addDaysIST(today, 1));
    const tokenOf = new Map(activeStocks(this.db).filter((s) => s.eqToken != null).map((s) => [s.symbol, s.eqToken!]));
    this.symbolOf = new Map();
    for (const r of listInRange(this.db, { from: today, to: until, q: null })) {
      const t = tokenOf.get(r.symbol);
      if (t != null) this.symbolOf.set(t, r.symbol);
    }
    const tokens = [...this.symbolOf.keys(), ...IN_INDICES.map((i) => i.token)];
    if (!this.session()) return;
    if (!this.stream) {
      this.stream = new KiteStream(this.session);
      this.stream.on('tick', (t: KiteTick) => this.onTick(t));
      this.stream.on('error', () => {}); // reconnects on its own
      this.stream.connect(tokens);
    } else {
      this.stream.setTokens(tokens);
    }
  }

  private onTick(t: KiteTick): void {
    this.ticks.set(t.token, { ...t, at: Date.now() });
    const sym = this.symbolOf.get(t.token);
    if (!sym) return;
    this.pending.add(sym);
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null;
      const all = this.snapshot();
      const out: Record<string, InLivePrice> = {};
      for (const s of this.pending) if (all[s]) out[s] = all[s];
      this.pending.clear();
      if (Object.keys(out).length) this.onPrices(out);
    }, PUSH_EVERY_MS);
  }

  private priceOf(token: number): InLivePrice | null {
    const t = this.ticks.get(token);
    return t ? { price: t.ltp, prevClose: t.close, changePct: changePct(t.ltp, t.close), at: new Date(t.at).toISOString() } : null;
  }

  /** Latest price per symbol. */
  snapshot(): Record<string, InLivePrice> {
    const out: Record<string, InLivePrice> = {};
    for (const [token, sym] of this.symbolOf) {
      const p = this.priceOf(token);
      if (p) out[sym] = p;
    }
    return out;
  }

  /** Latest index levels, by name. */
  indices(): Map<string, InLivePrice> {
    const out = new Map<string, InLivePrice>();
    for (const i of IN_INDICES) {
      const p = this.priceOf(i.token);
      if (p) out.set(i.name, p);
    }
    return out;
  }
}
