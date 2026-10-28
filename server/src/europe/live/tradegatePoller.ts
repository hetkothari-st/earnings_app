import { DateTime } from 'luxon';
import { TRADEGATE_CAL } from '../domain/calendars.js';
import type { createTradegate, TradegateQuote, TradegateState } from '../sources/tradegate.js';

const BERLIN = 'Europe/Berlin';
/** One request per second for the whole process (the client's limiter enforces it too). */
const TICK_MS = 1_000;
/** Ruling 14: in hours each ISIN at most every 30 s, otherwise every 15 min. */
const IN_HOURS_EVERY_MS = 30_000;
const OFF_HOURS_EVERY_MS = 15 * 60_000;
/** robots.txt is read at start and weekly; while it has not passed (state 'off-robots'), again every hour. */
const ROBOTS_EVERY_MS = 7 * 86_400_000;
const ROBOTS_RETRY_MS = 3_600_000;

const OPEN_MIN = 8 * 60;
const CLOSE_MIN = 22 * 60;

/** 08:00–22:00 Berlin on a Tradegate trading day. */
export function tradegateInHours(ms: number): boolean {
  const t = DateTime.fromMillis(ms, { zone: BERLIN });
  const m = t.hour * 60 + t.minute;
  return TRADEGATE_CAL.isTradingDay(t.toISODate()!) && m >= OPEN_MIN && m < CLOSE_MIN;
}

/**
 * The time a Tradegate price stands for: in hours the fetch time; outside them, the close (22:00 Berlin) of the last
 * session at or before the fetch, since the answer then carries that session's last trade.
 */
export function tradegatePriceTime(fetchedAt: string): string {
  const ms = Date.parse(fetchedAt);
  if (tradegateInHours(ms)) return fetchedAt;
  return tradegateLastCloseTime(fetchedAt);
}

/**
 * The close (22:00 Berlin) of the last session that ended at or before `fetchedAt`. An answer with no `last` (no
 * trade yet today) carries only that session's close, so in hours too its price stands for this time.
 */
export function tradegateLastCloseTime(fetchedAt: string): string {
  const ms = Date.parse(fetchedAt);
  let d = DateTime.fromMillis(ms, { zone: BERLIN });
  // Before 22:00 the day's session (if any) has not closed yet: the last close is an earlier day's.
  if (d.hour * 60 + d.minute < CLOSE_MIN) d = d.minus({ days: 1 });
  for (let i = 0; i < 14 && !TRADEGATE_CAL.isTradingDay(d.toISODate()!); i++) d = d.minus({ days: 1 });
  return d.set({ hour: 22, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
}

type Client = Pick<ReturnType<typeof createTradegate>, 'quote' | 'checkRobots' | 'state'>;

/**
 * The one Tradegate poller for UK and EU (Ruling 14). Every second it fetches at most one ISIN: of the wanted ISINs
 * (visible ∪ watched ∪ reporting today/tomorrow, both markets) that are due, the one fetched longest ago (never
 * fetched first), so the list is served round-robin. An ISIN is due every 30 s in Tradegate hours and every 15 min
 * outside them. robots.txt is checked at start and every 7 days (hourly while it has not passed); the client is
 * fail-closed, so nothing is fetched before a check passes. In state `backoff` or `off-*` a tick fetches no quote.
 * A failed or empty answer keeps the last quote. Only changed quotes are published, keyed by Yahoo symbol. A symbol
 * that leaves the wanted list loses its quote at the next tick. `onState` hears every change of the client's state.
 */
export class TradegatePoller {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastRobots = -Infinity;
  private readonly fetchedAt = new Map<string, number>();
  private readonly quotes = new Map<string, TradegateQuote>();
  /** Yahoo symbol → ISIN, from the last `wanted()`. */
  private readonly isinOf = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly wanted: () => { isin: string; symbol: string }[],
    private readonly publish: (changed: Record<string, TradegateQuote>) => void,
    private readonly now: () => number = Date.now,
    /** Called with the client's state when it changes (and once at the first tick): prices re-publish their venue. */
    private readonly onState?: (state: TradegateState) => void,
  ) {}

  private lastState: TradegateState | null = null;

  private noteState(): void {
    const s = this.client.state();
    if (s === this.lastState) return;
    this.lastState = s;
    this.onState?.(s);
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

  /** The last quote of every symbol that has one, keyed by Yahoo symbol. */
  snapshot(): Record<string, TradegateQuote> {
    const out: Record<string, TradegateQuote> = {};
    for (const [symbol, isin] of this.isinOf) {
      const q = this.quotes.get(isin);
      if (q) out[symbol] = q;
    }
    return out;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      // The wanted list is read every tick, whatever the state: a symbol no longer wanted is dropped with its quote,
      // so a quote nobody polls any more is never served.
      const symbolsOf = new Map<string, string[]>();
      this.isinOf.clear();
      for (const w of this.wanted()) {
        this.isinOf.set(w.symbol, w.isin);
        symbolsOf.set(w.isin, [...(symbolsOf.get(w.isin) ?? []), w.symbol]);
      }
      for (const isin of [...this.quotes.keys()]) if (!symbolsOf.has(isin)) this.quotes.delete(isin);
      for (const isin of [...this.fetchedAt.keys()]) if (!symbolsOf.has(isin)) this.fetchedAt.delete(isin);
      this.noteState();

      const robotsDue = now - this.lastRobots >= (this.client.state() === 'off-robots' ? ROBOTS_RETRY_MS : ROBOTS_EVERY_MS);
      if (robotsDue) {
        this.lastRobots = now;
        await this.client.checkRobots();
        this.noteState();
        return; // this second's request
      }
      if (this.client.state() !== 'on') return;

      const every = tradegateInHours(now) ? IN_HOURS_EVERY_MS : OFF_HOURS_EVERY_MS;
      let pick: string | null = null;
      let oldest = Infinity;
      for (const isin of symbolsOf.keys()) {
        const at = this.fetchedAt.get(isin) ?? -Infinity;
        if (now - at < every) continue;
        if (at < oldest) { oldest = at; pick = isin; }
      }
      if (!pick) return;
      this.fetchedAt.set(pick, now);
      const q = await this.client.quote(pick);
      this.noteState(); // a 429 / 403 just started a back-off
      if (!q) return; // keep the last quote
      const prev = this.quotes.get(pick);
      this.quotes.set(pick, q);
      if (prev && prev.last === q.last && prev.close === q.close) return;
      const changed: Record<string, TradegateQuote> = {};
      for (const symbol of symbolsOf.get(pick)!) changed[symbol] = q;
      this.publish(changed);
    } catch (err) {
      console.warn('tradegate poller:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }
}
