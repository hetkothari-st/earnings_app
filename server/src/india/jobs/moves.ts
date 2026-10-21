import { DateTime } from 'luxon';
import { inReportsForSnapshot, type PendingReport, saveInExpectedMove, saveInLiveMove } from '../db/inRepo.js';
import { chooseInExpiry, computeInExpectedMove, finalSnapshotDay, type InExpectedMove, type OptionTop } from '../domain/inMoves.js';
import { addDaysIST, IST, isNseTradingDay, NSE_CLOSE, NSE_OPEN, nextNseTradingDay } from '../domain/nseCalendar.js';
import { fetchKiteInstruments, filterOptionInstruments, type KiteInstrument, optionExpiries } from '../sources/foList.js';
import { type InJobContext, trackIn } from './context.js';

/** Strikes either side of the price that are quoted; the straddle uses the nearest two-sided one. */
const STRIKES_EACH_SIDE = 3;
/** A live move saved this recently (by the ticker) is not fetched again. */
const LIVE_FRESH_MS = 60_000;

let nfo: { day: string; list: KiteInstrument[] } | null = null;

/** NFO instruments, fetched once per IST day. */
export async function nfoInstruments(ctx: InJobContext): Promise<KiteInstrument[] | null> {
  const day = ctx.todayIST();
  if (nfo?.day === day) return nfo.list;
  const list = await trackIn(ctx, 'kite-instruments', () => fetchKiteInstruments(ctx.http, 'NFO'));
  if (!list) return null;
  nfo = { day, list };
  return list;
}

/** For tests. */
export function resetNfoCache(): void {
  nfo = null;
}

/**
 * Straddles for the given reports from one round of Kite quotes: spot for each stock, then the
 * calls and puts at the strikes around it for the expiry that captures the reaction.
 */
async function straddles(ctx: InJobContext, reports: PendingReport[]): Promise<Map<number, Omit<InExpectedMove, 'snapshotAt'> & { quoteTime: string | null }>> {
  const out = new Map<number, Omit<InExpectedMove, 'snapshotAt'> & { quoteTime: string | null }>();
  if (reports.length === 0) return out;
  const instruments = await nfoInstruments(ctx);
  if (!instruments) return out;

  const spots = await trackIn(ctx, 'kite-quotes', () => ctx.kite.quotes([...new Set(reports.map((r) => `NSE:${r.symbol}`))]));
  if (!spots) return out;

  const plans: { report: PendingReport; expiry: string; underlying: number; options: KiteInstrument[] }[] = [];
  for (const r of reports) {
    const underlying = spots.get(`NSE:${r.symbol}`)?.lastPrice;
    const expiry = chooseInExpiry(optionExpiries(instruments, r.symbol), r.reportDate, r.timing);
    if (!underlying || !expiry) continue;
    const chain = filterOptionInstruments(instruments, r.symbol, expiry);
    const strikes = [...new Set(chain.map((o) => o.strike))].sort((a, b) => Math.abs(a - underlying) - Math.abs(b - underlying))
      .slice(0, STRIKES_EACH_SIDE * 2);
    plans.push({ report: r, expiry, underlying, options: chain.filter((o) => strikes.includes(o.strike)) });
  }
  const keys = plans.flatMap((p) => p.options.map((o) => `NFO:${o.tradingsymbol}`));
  const quotes = await trackIn(ctx, 'kite-quotes', () => ctx.kite.quotes(keys));
  if (!quotes) return out;

  for (const p of plans) {
    const tops: OptionTop[] = [];
    let quoteTime: string | null = null;
    for (const o of p.options) {
      const q = quotes.get(`NFO:${o.tradingsymbol}`);
      if (!q) continue;
      tops.push({ strike: o.strike, type: o.instrumentType as 'CE' | 'PE', bid: q.bid, ask: q.ask });
      if (q.timestamp && (!quoteTime || q.timestamp > quoteTime)) quoteTime = q.timestamp;
    }
    const em = computeInExpectedMove(tops, p.underlying, p.expiry, p.report.symbol);
    if (em) out.set(p.report.id, { ...em, quoteTime });
  }
  return out;
}

/**
 * Expected-move snapshot near the close (15:25 IST, while the order book is still live). Final when
 * today's close is the last one before the release; provisional (≈) from earlier days.
 */
export async function snapshotInMoves(ctx: InJobContext): Promise<void> {
  if (!ctx.kiteSession()) return; // no Kite session: expected move stays "—"
  const today = ctx.todayIST();
  if (!isNseTradingDay(today)) return;
  const due = inReportsForSnapshot(ctx.db, today, addDaysIST(today, 10)).filter((r) => finalSnapshotDay(r.reportDate, r.timing) >= today);
  const ems = await straddles(ctx, due);
  const now = ctx.now();
  for (const r of due) {
    const em = ems.get(r.id);
    if (em) saveInExpectedMove(ctx.db, r.id, em, finalSnapshotDay(r.reportDate, r.timing) === today, now);
  }
}

/** True during the NSE regular session. */
export function inSession(nowIso: string): boolean {
  const t = DateTime.fromISO(nowIso, { zone: IST });
  const hm = t.toFormat('HH:mm');
  return isNseTradingDay(t.toISODate()!) && hm >= NSE_OPEN && hm <= NSE_CLOSE;
}

/** Live expected move (every minute in session) for today's and the next session's unreleased reports. */
export async function refreshInLiveMoves(ctx: InJobContext): Promise<number[]> {
  if (!ctx.kiteSession() || !inSession(ctx.now())) return [];
  const today = ctx.todayIST();
  const nowMs = Date.parse(ctx.now());
  // The ticker (InPrices) saves live moves within seconds; this poll only fills in what it did not.
  const fresh = new Set((ctx.db.prepare('SELECT report_id AS id, fetched_at AS at FROM in_live_moves').all() as { id: number; at: string }[])
    .filter((m) => nowMs - Date.parse(m.at) < LIVE_FRESH_MS).map((m) => m.id));
  const reports = inReportsForSnapshot(ctx.db, today, nextNseTradingDay(addDaysIST(today, 1)), true).filter((r) => !fresh.has(r.id));
  const ems = await straddles(ctx, reports);
  const now = ctx.now();
  const changed: number[] = [];
  for (const [id, em] of ems) {
    if (saveInLiveMove(ctx.db, id, { movePct: em.movePct, illiquid: em.illiquid, quoteTime: em.quoteTime }, now)) changed.push(id);
  }
  return changed;
}
