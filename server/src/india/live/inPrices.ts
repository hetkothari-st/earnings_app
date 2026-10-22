import type { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { createFailover } from '../../sources/failover.js';
import type { Http } from '../../sources/http.js';
import { inReportsForSnapshot, listInRange, matchableStocks, type PendingReport, saveInLiveMove } from '../db/inRepo.js';
import { chooseInExpiry, computeInExpectedMove, type OptionTop } from '../domain/inMoves.js';
import { addDaysIST, nextNseTradingDay } from '../domain/nseCalendar.js';
import type { InJobContext } from '../jobs/context.js';
import { inSession, nfoInstruments } from '../jobs/moves.js';
import { filterOptionInstruments, type KiteInstrument, optionExpiries } from '../sources/foList.js';
import type { KiteSession } from '../sources/kiteLogin.js';
import { KiteStream, type KiteTick } from '../sources/kiteStream.js';
import { fetchYahooIndex } from '../sources/yahooIn.js';

export interface InLivePrice { price: number; prevClose: number | null; changePct: number | null; at: string; source: 'stream' | 'backup' }

/** Index tokens on Kite (segment byte 9 = index). */
export const IN_INDICES: { name: string; token: number; yahoo: string }[] = [
  { name: 'NIFTY 50', token: 256265, yahoo: '^NSEI' },
  { name: 'SENSEX', token: 265, yahoo: '^BSESN' },
  { name: 'NIFTY BANK', token: 260105, yahoo: '^NSEBANK' },
  { name: 'NIFTY MIDCAP 100', token: 256777, yahoo: 'NIFTY_MIDCAP_100.NS' },
];

const PUSH_EVERY_MS = 500;
const RESUBSCRIBE_EVERY_MS = 5 * 60_000;
/** Kite allows 3,000 instruments per connection. */
export const MAX_STREAM_TOKENS = 3_000;
/** Strikes per report whose calls and puts are streamed. */
const STRIKES = 6;
/** A live move is saved at most this often per report. */
const MOVE_EVERY_MS = 5_000;
/** An equity with no tick for this long during the session gets a Yahoo price. */
const STALE_MS = 2 * 60_000;
const BACKUP_CHECK_EVERY_MS = 30_000;
const BACKUP_PER_CHECK = 25;
/** Strikes are re-picked for a symbol at most this often when its price leaves them. */
const RESYNC_EVERY_MS = 30_000;
/** After the instrument list failed to load, wait this long before trying again. */
const INSTRUMENTS_RETRY_MS = 10_000;
/** A live move needs a quoted strike within this many strike gaps of the price. */
const MAX_STRIKE_GAPS = 1.5;
const IST_OFFSET_MS = 5.5 * 3_600_000;

const changePct = (price: number, prev: number | null) => (prev && prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : null);

export interface OptionRef { reportId: number; strike: number; type: 'CE' | 'PE' }

/**
 * The calls and puts at the 6 strikes nearest the price, for the expiry that captures each
 * report's reaction. Reports without a known price get none.
 */
export function optionTokensFor(
  instruments: KiteInstrument[], reports: PendingReport[], spots: Map<string, number>,
): Map<number, OptionRef> {
  const out = new Map<number, OptionRef>();
  for (const r of reports) {
    const spot = spots.get(r.symbol);
    const expiry = chooseInExpiry(optionExpiries(instruments, r.symbol), r.reportDate, r.timing);
    if (!spot || !expiry) continue;
    const chain = filterOptionInstruments(instruments, r.symbol, expiry);
    const strikes = new Set([...new Set(chain.map((o) => o.strike))]
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, STRIKES));
    for (const o of chain) {
      if (strikes.has(o.strike) && (o.instrumentType === 'CE' || o.instrumentType === 'PE')) {
        out.set(o.instrumentToken, { reportId: r.id, strike: o.strike, type: o.instrumentType });
      }
    }
  }
  return out;
}

/** What InPrices needs from the Kite ticker (the real one is KiteStream). */
export interface TickStream extends EventEmitter {
  connect(tokens: number[], fullTokens?: number[]): void;
  setTokens(tokens: number[], fullTokens?: number[]): void;
  disconnect(): void;
}

export interface InPricesDeps {
  makeStream: (session: () => KiteSession | null) => TickStream;
  now: () => number;
  /** Yahoo price for an NSE symbol; null when unavailable. */
  yahoo: (symbol: string) => Promise<{ price: number; prevClose: number | null } | null>;
  /** NFO instruments (cached per day). */
  instruments: () => Promise<KiteInstrument[] | null>;
  onMoves: (ids: number[]) => void;
}

/** Yahoo chart price (`<SYMBOL>.NS`) behind the failover, which records errors and backs off on blocks. */
export function createYahooPriceBackup(db: DatabaseSync, http: Http, now: () => number = Date.now): InPricesDeps['yahoo'] {
  const failover = createFailover(db, now);
  return async (symbol) => (await failover({ name: 'yahoo-in-prices', run: () => fetchYahooIndex(http, `${symbol}.NS`) }, null))?.value ?? null;
}

interface ReportOptions {
  symbol: string; expiry: string; tokens: number[];
  listed: number[];      // every strike listed for the expiry, ascending
  subscribed: number[];  // the distinct strikes streamed, ascending
}

/**
 * Real-time prices from the Kite ticker for every F&O stock and watched stock, plus the four indices,
 * and live expected moves from the option prices of today's and the next session's reporters.
 * Changes are pushed at most once a second. Without a session nothing streams.
 */
export class InPrices {
  private stream: TickStream | null = null;
  private ticks = new Map<number, KiteTick & { at: number }>();
  private symbolOf = new Map<number, string>();
  private tokenOf = new Map<string, number>();
  private pending = new Set<string>();
  private pushTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private backups = new Map<string, InLivePrice & { fetchedAt: number }>();
  private lastTry = new Map<string, number>();
  private options = new Map<number, OptionRef>();
  private optionsByReport = new Map<number, ReportOptions>();
  private awaitingSpot = new Set<string>();
  private lastSaved = new Map<number, number>();
  private lastResync = new Map<string, number>();
  private instrumentsFailedAt = -Infinity;
  private backingUp = false;
  private moveTimers = new Map<number, NodeJS.Timeout>();
  private syncing = false;
  private readonly deps: InPricesDeps;

  constructor(
    private readonly db: DatabaseSync,
    private readonly session: () => KiteSession | null,
    private readonly today: () => string,
    private readonly onPrices: (prices: Record<string, InLivePrice>) => void,
    deps: Partial<InPricesDeps> = {},
  ) {
    this.deps = {
      makeStream: (s) => new KiteStream(s),
      now: Date.now,
      yahoo: async () => null,
      instruments: async () => null,
      onMoves: () => {},
      ...deps,
    };
  }

  /** Production wiring: the NFO cache and Yahoo (behind the failover) come from the job context. */
  static forContext(
    ctx: InJobContext, onPrices: (prices: Record<string, InLivePrice>) => void, onMoves: (ids: number[]) => void,
  ): InPrices {
    return new InPrices(ctx.db, ctx.kiteSession, ctx.todayIST, onPrices, {
      yahoo: createYahooPriceBackup(ctx.db, ctx.http),
      instruments: () => nfoInstruments(ctx),
      onMoves,
    });
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), RESUBSCRIBE_EVERY_MS);
    this.backupTimer = setInterval(() => void this.checkBackup(), BACKUP_CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    for (const t of this.moveTimers.values()) clearTimeout(t);
    this.moveTimers.clear();
    this.stream?.disconnect();
    this.stream = null;
  }

  /** Re-pick what to stream (reporters and watchlists change through the day) and connect if needed. */
  async refresh(): Promise<void> {
    // Every F&O stock and every watched stock.
    this.symbolOf = new Map();
    this.tokenOf = new Map();
    const now = this.deps.now();
    for (const s of matchableStocks(this.db)) {
      if (s.eqToken == null) continue;
      this.symbolOf.set(s.eqToken, s.symbol);
      this.tokenOf.set(s.symbol, s.eqToken);
      if (!this.lastTry.has(s.symbol)) this.lastTry.set(s.symbol, now); // silence is counted from here
    }
    if (!this.session()) return;
    this.subscribe();
    await this.syncOptions();
  }

  /** Equities and indices in quote mode, option contracts in full mode (for the depth). */
  private subscribe(): void {
    const eq = [...this.symbolOf.keys(), ...IN_INDICES.map((i) => i.token)].slice(0, MAX_STREAM_TOKENS);
    const full = [...this.options.keys()].slice(0, MAX_STREAM_TOKENS - eq.length);
    if (!this.stream) {
      this.stream = this.deps.makeStream(this.session);
      this.stream.on('tick', (t: KiteTick) => this.onTick(t));
      this.stream.on('error', () => {}); // reconnects on its own
      this.stream.connect([...eq, ...full], full);
    } else {
      this.stream.setTokens([...eq, ...full], full);
    }
  }

  /** Pick the option contracts for unreleased reports today and the next session, then resubscribe. */
  private async syncOptions(): Promise<boolean> {
    if (this.syncing || !this.session()) return false;
    this.syncing = true;
    try {
      const today = this.today();
      const reports = inReportsForSnapshot(this.db, today, nextNseTradingDay(addDaysIST(today, 1)), true);
      const spots = new Map<string, number>();
      for (const sym of this.tokenOf.keys()) {
        const spot = this.spotOf(sym);
        if (spot != null) spots.set(sym, spot);
      }
      this.awaitingSpot = new Set(reports.filter((r) => !spots.has(r.symbol)).map((r) => r.symbol));
      const instruments = await this.deps.instruments();
      if (!instruments) {
        // Retry on a later price tick: every reporter counts as waiting.
        this.instrumentsFailedAt = this.deps.now();
        for (const r of reports) this.awaitingSpot.add(r.symbol);
        return false;
      }
      this.options = optionTokensFor(instruments, reports, spots);
      this.optionsByReport = new Map();
      for (const [token, o] of this.options) {
        const r = reports.find((x) => x.id === o.reportId)!;
        let e = this.optionsByReport.get(o.reportId);
        if (!e) {
          const expiry = chooseInExpiry(optionExpiries(instruments, r.symbol), r.reportDate, r.timing)!;
          const listed = [...new Set(filterOptionInstruments(instruments, r.symbol, expiry).map((i) => i.strike))].sort((a, b) => a - b);
          e = { symbol: r.symbol, expiry, tokens: [], listed, subscribed: [] };
          this.optionsByReport.set(o.reportId, e);
        }
        e.tokens.push(token);
        if (!e.subscribed.includes(o.strike)) e.subscribed.push(o.strike);
      }
      const at = this.deps.now();
      for (const e of this.optionsByReport.values()) {
        e.subscribed.sort((a, b) => a - b);
        this.lastResync.set(e.symbol, at);
      }
      this.subscribe();
      return true;
    } finally {
      this.syncing = false;
    }
  }

  private onTick(t: KiteTick): void {
    this.ticks.set(t.token, { ...t, at: this.deps.now() });
    const opt = this.options.get(t.token);
    if (opt) return this.onOptionTick(opt.reportId);
    const sym = this.symbolOf.get(t.token);
    if (!sym) return;
    if (this.awaitingSpot.has(sym)) {
      // First price of a reporter: now its strikes are known.
      if (this.deps.now() - this.instrumentsFailedAt >= INSTRUMENTS_RETRY_MS) {
        void this.syncOptions().then((ok) => { if (ok) this.awaitingSpot.delete(sym); });
      }
    } else if (this.leftStrikes(sym, t.ltp)) {
      void this.syncOptions();
    }
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

  /** Today's last price of an equity; a tick from an earlier IST day is not a price to pick strikes by. */
  private spotOf(sym: string): number | undefined {
    const t = this.ticks.get(this.tokenOf.get(sym) ?? -1);
    return t && new Date(t.at + IST_OFFSET_MS).toISOString().slice(0, 10) === this.today() ? t.ltp : undefined;
  }

  /** True when the price is beyond the second strike from either end of those streamed (and not re-picked in the last 30 s). */
  private leftStrikes(sym: string, spot: number): boolean {
    if (this.deps.now() - (this.lastResync.get(sym) ?? -Infinity) < RESYNC_EVERY_MS) return false;
    for (const e of this.optionsByReport.values()) {
      const s = e.subscribed;
      if (e.symbol === sym && s.length > 0 && (s.length < 4 || spot < s[1]! || spot > s[s.length - 2]!)) return true;
    }
    return false;
  }

  /** Saves at once when the last save is old enough, else when the window has passed. */
  private onOptionTick(reportId: number): void {
    if (this.moveTimers.has(reportId)) return;
    const wait = MOVE_EVERY_MS - (this.deps.now() - (this.lastSaved.get(reportId) ?? -Infinity));
    if (wait <= 0) return this.saveMove(reportId);
    this.moveTimers.set(reportId, setTimeout(() => { this.moveTimers.delete(reportId); this.saveMove(reportId); }, wait));
  }

  private saveMove(reportId: number): void {
    const plan = this.optionsByReport.get(reportId);
    const spot = plan ? this.spotOf(plan.symbol) : undefined;
    if (!plan || !spot) return;
    if (!inSession(new Date(this.deps.now()).toISOString())) return; // no live move outside the session
    const tops: OptionTop[] = [];
    let latest = 0;
    for (const token of plan.tokens) {
      const t = this.ticks.get(token);
      const o = this.options.get(token);
      if (!t || !o || t.bid == null || t.ask == null) continue;
      if (new Date(t.at + IST_OFFSET_MS).toISOString().slice(0, 10) !== this.today()) continue; // an earlier day's quote
      tops.push({ strike: o.strike, type: o.type, bid: t.bid, ask: t.ask });
      latest = Math.max(latest, t.at);
    }
    const em = computeInExpectedMove(tops, spot, plan.expiry, plan.symbol);
    if (!em) return;
    // The price may have left the streamed strikes: a far-away strike gives an in-the-money straddle, not the expected move.
    const near = plan.listed.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), plan.listed[0]!);
    const i = plan.listed.indexOf(near);
    const gaps = [plan.listed[i + 1]! - near, near - plan.listed[i - 1]!].filter((g) => g > 0);
    if (gaps.length && Math.abs(em.strike - spot) > MAX_STRIKE_GAPS * Math.min(...gaps)) return;
    const now = this.deps.now();
    this.lastSaved.set(reportId, now);
    const changed = saveInLiveMove(this.db, reportId,
      { movePct: em.movePct, illiquid: em.illiquid, quoteTime: new Date(latest).toISOString() }, new Date(now).toISOString());
    if (changed) this.deps.onMoves([reportId]);
  }

  /** Yahoo prices for equities silent for 2 minutes during the session. */
  async checkBackup(): Promise<void> {
    const now = this.deps.now();
    // Also without a Kite session (login failed): the prices then come from Yahoo alone.
    if (this.backingUp || !inSession(new Date(now).toISOString())) return;
    this.backingUp = true;
    try {
      await this.backupPass(now);
    } finally {
      this.backingUp = false;
    }
  }

  private async backupPass(now: number): Promise<void> {
    const due: string[] = [];
    for (const [token, sym] of this.symbolOf) {
      const last = Math.max(this.ticks.get(token)?.at ?? 0, this.lastTry.get(sym) ?? 0);
      if (now - last >= STALE_MS) due.push(sym);
    }
    // Reporters of today and the next session first.
    const today = this.today();
    const range = { from: today, to: nextNseTradingDay(addDaysIST(today, 1)) };
    const reporters = new Set([...inReportsForSnapshot(this.db, range.from, range.to, true).map((x) => x.symbol),
      ...listInRange(this.db, { ...range, q: null }).map((x) => x.symbol)]);
    due.sort((a, b) => Number(reporters.has(b)) - Number(reporters.has(a)));
    const out: Record<string, InLivePrice> = {};
    for (const sym of due.slice(0, BACKUP_PER_CHECK)) {
      const y = await this.deps.yahoo(sym).catch(() => null);
      const t = this.deps.now();
      this.lastTry.set(sym, t);
      if (!y) continue;
      const p = { price: y.price, prevClose: y.prevClose, changePct: changePct(y.price, y.prevClose), at: new Date(t).toISOString(), source: 'backup' as const, fetchedAt: t };
      this.backups.set(sym, p);
      out[sym] = p;
    }
    if (Object.keys(out).length) this.onPrices(out);
  }

  private priceOf(token: number): InLivePrice | null {
    const t = this.ticks.get(token);
    return t ? { price: t.ltp, prevClose: t.close, changePct: changePct(t.ltp, t.close), at: new Date(t.at).toISOString(), source: 'stream' } : null;
  }

  /** Latest price per symbol; a Yahoo price shows only while it is newer than the last tick. */
  snapshot(): Record<string, InLivePrice> {
    const out: Record<string, InLivePrice> = {};
    for (const [token, sym] of this.symbolOf) {
      const b = this.backups.get(sym);
      if (b && b.fetchedAt > (this.ticks.get(token)?.at ?? 0)) {
        out[sym] = { price: b.price, prevClose: b.prevClose, changePct: b.changePct, at: b.at, source: 'backup' };
        continue;
      }
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
