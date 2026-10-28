/**
 * UK / EU report dates, as Japan (`jp/jobs/calendar.ts`):
 *
 * - `refreshEuropeCalendar`: a rolling per-symbol sweep of quoteSummary `calendarEvents` through the one shared Yahoo
 *   client, always inside `sweepTurns.run(market)` so the JP, UK and EU sweeps take turns. Every active symbol once a
 *   day; near-term symbols (an unreleased report within 14 days, or no date seen in the last 7 days) every 6 h. Each
 *   run takes at most `perRun` symbols (Ruling 12: UK 20 / 60 in peak windows, EU 50 / 150), longest overdue first;
 *   progress is kept per symbol in `europe_date_sweep`, so a restart resumes the cycle, and symbols never checked go
 *   first, those with no stored date ahead of the rest.
 * - `refreshEuropeBulkCalendar`: the bulk calendar of each Yahoo region of the market marked `bulkCalendar: true`, as
 *   a supplement only. It creates rows for periods that have none and supplies TAS timing; it never moves a stored date.
 *
 * Both: dates before today never create a row, nor do dates more than 120 days ahead; a stock without a fiscal-year
 * end gets no row (Ruling 6). The period is `europePeriodFor` and is confirmed only by a trend `0q` end equal to it
 * (Ruling 7): a late reporter's row (AIM FY-Dec results on 2026-05-20 → 2026-03-31) stays unconfirmed. Full level
 * merges the ADR's US row (Ruling 11, `europeDateFromUs`: US AMC → the next local day): used when Yahoo agrees, has no
 * date for that period or has only its own projection; a date Yahoo marks announced wins a disagreement; with no flag
 * (bulk rows) a disagreement writes nothing. Everything is written `estimated`; the repo never lets an estimated date
 * move a confirmed one or a released row.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import { usAdrRows } from '../../db/adrRows.js';
import { recordSourceError } from '../../db/repo.js';
import { type SweepTurns, sweepTurns } from '../../sources/sweepTurns.js';
import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import {
  type EuropeStock, europeReportsBetween, europeStocks, findEuropeReportId, getEuropeReport, setEuropeTiming, upsertEuropeCalendarRow,
  upsertEuropePastDates,
} from '../db/europeRepo.js';
import { europeDateFromUs } from '../domain/calendars.js';
import { type EuropePeriod, europePeriodFor, europePeriodLabel } from '../domain/period.js';
import { exchangesOf, type EuropeMarket } from '../exchanges.js';
import { type EuropeCalRow, YAHOO_REGIONS } from '../sources/yahooEurope.js';
import { trackIn, type EuropeJobContext } from './context.js';
import { addDaysEurope, applyEuropeSummary, europeEstimateRows, trendQuarterEnd } from './estimates.js';
import { yahooSource } from './stocks.js';

const HOUR = 3_600_000;

export const EUROPE_SWEEP = {
  fullCycleMs: 24 * HOUR,
  nearTermMs: 6 * HOUR,
  nearTermDays: 14,
  noDateMs: 7 * 24 * HOUR,
  /** A cached summary younger than this is reused (the estimates job may have just fetched it). */
  maxAgeMs: 30 * 60_000,
} as const;

/** Dates further ahead than this are not written. */
const AHEAD_DAYS = 120;
/** A stale calendar date this recent can be a past date (previous moves need 45–140 days). */
const PAST_DAYS = 140;

const turnOf = (market: EuropeMarket): 'uk' | 'eu' => (market === 'UK' ? 'uk' : 'eu');

/** The Yahoo regions of the market whose bulk calendar is current (`YAHOO_REGIONS[ex].bulkCalendar`), each once. */
export function europeBulkRegions(market: EuropeMarket): string[] {
  return [...new Set(exchangesOf(market).filter((ex) => YAHOO_REGIONS[ex].bulkCalendar).map((ex) => YAHOO_REGIONS[ex].region))];
}

// ---------- Sweep progress (europe_date_sweep, created by ensureEuropeSchema) ----------

interface SweepState { checkedAt: string; dateSeenAt: string | null; announcedDate: string | null }

function sweepState(db: DatabaseSync): Map<string, SweepState> {
  const rows = db.prepare('SELECT symbol, checked_at, date_seen_at, announced_date FROM europe_date_sweep').all() as
    { symbol: string; checked_at: string; date_seen_at: string | null; announced_date: string | null }[];
  return new Map(rows.map((r) => [r.symbol, { checkedAt: r.checked_at, dateSeenAt: r.date_seen_at, announcedDate: r.announced_date }]));
}

/** `announced`: a date today or later that Yahoo marked as announced by the company. */
function markChecked(db: DatabaseSync, symbol: string, now: string, dateSeen: boolean, announced: string | null = null): void {
  db.prepare(`INSERT INTO europe_date_sweep (symbol, checked_at, date_seen_at, announced_date) VALUES (?, ?, ?, ?)
    ON CONFLICT (symbol) DO UPDATE SET checked_at = excluded.checked_at, date_seen_at = COALESCE(excluded.date_seen_at, date_seen_at),
      announced_date = COALESCE(excluded.announced_date, announced_date)`)
    .run(symbol, now, dateSeen ? now : null, announced);
}

// ---------- Date planning (shared) ----------

/** `announced`: Yahoo's `isEarningsDateEstimate` inverted (true: announced, false: Yahoo's projection, null: no flag). */
interface Candidate { date: string; timing: LocalTiming; tas: boolean; announced?: boolean | null }
interface Planned extends Candidate { period: EuropePeriod }

/**
 * The dates to write for one stock, one per fiscal period. Yahoo dates outside [today, today+120] are dropped; two
 * different Yahoo dates for one period are ambiguous and both dropped. Full level: the ADR's US rows as local dates of
 * the stock's exchange; per period, a US date is used when Yahoo agrees, has none or has only a projected one; an
 * announced Yahoo date wins a disagreement; a Yahoo date with no flag and a different US date write nothing.
 */
function planDates(ctx: EuropeJobContext, stock: EuropeStock, yahoo: Candidate[]): Planned[] {
  const fy = stock.fyEndMonth;
  if (fy == null) return [];
  const today = ctx.today();
  const end = addDaysEurope(ctx, today, AHEAD_DAYS);
  const inRange = (d: string) => d >= today && d <= end;

  const ys = new Map<string, { dates: Set<string>; best: Planned }>();
  for (const c of yahoo.filter((c) => inRange(c.date))) {
    const period = europePeriodFor(c.date, fy);
    const e = ys.get(period.periodEnd);
    if (!e) { ys.set(period.periodEnd, { dates: new Set([c.date]), best: { ...c, period } }); continue; }
    e.dates.add(c.date);
    if (c.tas && !e.best.tas && c.date === e.best.date) e.best = { ...c, period };
  }

  const us = new Map<string, Planned>();
  if (stock.level === 'full' && stock.adr) {
    for (const u of usAdrRows(ctx.db, stock.adr, addDaysEurope(ctx, today, -1), end)) {
      const date = europeDateFromUs(stock.exchange, u.reportDate, u.timing);
      if (!inRange(date)) continue;
      const period = europePeriodFor(date, fy);
      const have = us.get(period.periodEnd);
      if (!have || date < have.date) us.set(period.periodEnd, { date, timing: 'UNKNOWN', tas: false, period });
    }
  }

  const out: Planned[] = [];
  for (const periodEnd of new Set([...ys.keys(), ...us.keys()])) {
    const y = ys.get(periodEnd);
    const u = us.get(periodEnd);
    if (y && y.dates.size > 1) continue; // ambiguous
    if (y && u) {
      if (y.best.date === u.date || y.best.announced === true) out.push(y.best);
      else if (y.best.announced === false) out.push(u);
      continue;
    }
    if (y) out.push(y.best);
    else if (u) out.push(u);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** `q0`: the summary trend's `0q` end; equal to the period end, it confirms the period (Ruling 7). */
function writePlanned(ctx: EuropeJobContext, stock: EuropeStock, p: Planned, q0: string | null): number {
  const id = upsertEuropeCalendarRow(ctx.db, ctx.market, {
    symbol: stock.symbol, name: stock.name, exchange: stock.exchange, period: p.period, periodLabel: europePeriodLabel(p.period),
    periodConfirmed: q0 != null && q0 === p.period.periodEnd, reportDate: p.date, dateStatus: 'estimated',
  }, ctx.now());
  timingIfSameDate(ctx, id, p);
  return id;
}

/** A TAS time sets the timing only when the stored row is on that very date (and its timing is still unknown). */
function timingIfSameDate(ctx: EuropeJobContext, id: number, p: Candidate): void {
  if (!p.tas || p.timing === 'UNKNOWN') return;
  if (getEuropeReport(ctx.db, id)?.reportDate === p.date) setEuropeTiming(ctx.db, id, p.timing, 'yahoo');
}

// ---------- Rolling per-symbol sweep ----------

/**
 * The symbols due now, in sweep order: never checked (no stored date first), then longest overdue. A stock with no
 * fiscal-year end is still swept once a day (the summary may supply one, Ruling 6), never on the 6-hour cadence.
 */
function dueSymbols(ctx: EuropeJobContext, stocks: EuropeStock[]): EuropeStock[] {
  const today = ctx.today();
  const nowMs = Date.parse(ctx.now());
  const state = sweepState(ctx.db);
  const withDate = new Set((ctx.db.prepare('SELECT DISTINCT symbol FROM europe_reports WHERE market = ? AND report_date >= ?')
    .all(ctx.market, today) as { symbol: string }[]).map((r) => r.symbol));
  const nearTerm = new Set(europeReportsBetween(ctx.db, ctx.market, today, addDaysEurope(ctx, today, EUROPE_SWEEP.nearTermDays))
    .filter((r) => r.releasedAt == null && !r.hasEps).map((r) => r.symbol));

  const due: { stock: EuropeStock; rank: number; at: number }[] = [];
  for (const stock of stocks) {
    const st = state.get(stock.symbol);
    if (!st) { due.push({ stock, rank: withDate.has(stock.symbol) ? 1 : 0, at: 0 }); continue; }
    const noDate = stock.fyEndMonth != null && (st.dateSeenAt == null || Date.parse(st.dateSeenAt) < nowMs - EUROPE_SWEEP.noDateMs);
    const interval = nearTerm.has(stock.symbol) || noDate ? EUROPE_SWEEP.nearTermMs : EUROPE_SWEEP.fullCycleMs;
    const at = Date.parse(st.checkedAt) + interval;
    if (at <= nowMs) due.push({ stock, rank: 2, at });
  }
  return due
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.stock.symbol.localeCompare(b.stock.symbol))
    .map((d) => d.stock);
}

/**
 * One run of the rolling date sweep (see the file comment), inside `turns.run(market)`. For each due symbol: the
 * summary's fiscal-year end is stored (source `yahoo`) when the stock has none; a single next date today or later is
 * planned and written (`estimated`, also when Yahoo marks it announced, as Japan); a stale (past) date never creates a
 * row, but is kept as a past date only when Yahoo marks it announced, it lies within 140 days and earningsHistory
 * already has an actual for exactly the period it closes. A date Yahoo marks as its own projection never moves a row
 * standing on the symbol's last announced date. The same summary also feeds estimates and sector / industry. A failed
 * request records a `yahoo-<market>-calendar` error and ends the run: rows written so far stay, and the failed symbol
 * waits for its next turn.
 */
export async function refreshEuropeCalendar(ctx: EuropeJobContext, opts: { perRun: number; turns?: SweepTurns }): Promise<void> {
  const turns = opts.turns ?? sweepTurns;
  await turns.run(turnOf(ctx.market), () => sweep(ctx, opts.perRun));
}

async function sweep(ctx: EuropeJobContext, perRun: number): Promise<void> {
  const today = ctx.today();
  const stocks = europeStocks(ctx.db, ctx.market).filter((s) => s.active);
  const state = sweepState(ctx.db);
  for (const listed of dueSymbols(ctx, stocks).slice(0, Math.max(0, perRun))) {
    const y = await trackIn(ctx, yahooSource(ctx, 'calendar'), () => ctx.yahooSummary(listed.symbol, EUROPE_SWEEP.maxAgeMs));
    if (y === undefined) {
      markChecked(ctx.db, listed.symbol, ctx.now(), false);
      return;
    }
    const stock = y && listed.fyEndMonth == null && y.fyEndMonth != null ? { ...listed, fyEndMonth: y.fyEndMonth } : listed;
    const next = y?.nextDate ?? null;
    const seen = next != null && next >= today;
    const projected = y?.nextDateEstimated === true;
    const announcedBefore = state.get(stock.symbol)?.announcedDate ?? null;
    const announced = y?.nextDateEstimated == null ? null : !y.nextDateEstimated;
    const q0 = y ? trendQuarterEnd(y) : null;
    for (const p of planDates(ctx, stock, seen ? [{ date: next, timing: 'UNKNOWN', tas: false, announced }] : [])) {
      // Announced beats projected: Yahoo's projection never moves a row standing on the last announced date.
      if (projected && announcedBefore != null && announcedBefore !== p.date) {
        const stored = findEuropeReportId(ctx.db, stock.symbol, p.period.periodEnd);
        if (stored != null && getEuropeReport(ctx.db, stored)?.reportDate === announcedBefore) continue;
      }
      writePlanned(ctx, stock, p, q0);
    }
    // Only a date Yahoo marks as announced can be a past date: a projection that passed may have missed by days.
    if (y && next != null && !seen && y.nextDateEstimated === false) keepPastDate(ctx, stock, next, y.epsHistory);
    if (y) applyEuropeSummary(ctx, listed, europeEstimateRows(ctx, stock.symbol), y);
    markChecked(ctx.db, stock.symbol, ctx.now(), seen, seen && y?.nextDateEstimated === false ? next : null);
  }
}

function keepPastDate(ctx: EuropeJobContext, stock: EuropeStock, date: string, history: YahooForeignSummary['epsHistory']): void {
  if (stock.fyEndMonth == null || date < addDaysEurope(ctx, ctx.today(), -PAST_DAYS)) return;
  const periodEnd = europePeriodFor(date, stock.fyEndMonth).periodEnd;
  if (history.some((h) => h.periodEnd === periodEnd)) upsertEuropePastDates(ctx.db, [{ symbol: stock.symbol, date, timing: null }]);
}

// ---------- Bulk calendar supplement ----------

/**
 * The bulk calendar `[today, today+120]` of each enabled region of the market (`regions`, default
 * `europeBulkRegions`), as a supplement: a period with no stored row gets one (`estimated`), and a TAS row on a stored
 * row's own date sets its timing (`setEuropeTiming`, only while unknown). Stored dates are never moved here (the
 * per-symbol sweep owns them). No enabled region: no request. An incomplete sweep writes what it got and records a
 * `yahoo-<market>-calendar` error.
 */
export async function refreshEuropeBulkCalendar(ctx: EuropeJobContext, opts: { regions?: readonly string[] } = {}): Promise<void> {
  const regions = opts.regions ?? europeBulkRegions(ctx.market);
  if (regions.length === 0) return;
  const today = ctx.today();
  const stocks = new Map(europeStocks(ctx.db, ctx.market).filter((s) => s.active).map((s) => [s.symbol, s]));
  for (const region of regions) {
    const sweepResult = await trackIn(ctx, yahooSource(ctx, 'calendar'),
      () => ctx.yahooCalendar(region, today, addDaysEurope(ctx, today, AHEAD_DAYS)));
    if (!sweepResult) continue;
    const bySymbol = new Map<string, EuropeCalRow[]>();
    for (const r of sweepResult.rows) if (stocks.has(r.symbol)) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
    for (const [symbol, rows] of bySymbol) {
      const stock = stocks.get(symbol)!;
      const candidates = rows.map((r) => ({
        date: r.date, timing: r.timeType === 'TAS' ? r.timing : 'UNKNOWN' as LocalTiming, tas: r.timeType === 'TAS',
      }));
      for (const p of planDates(ctx, stock, candidates)) {
        const stored = findEuropeReportId(ctx.db, symbol, p.period.periodEnd);
        if (stored != null) timingIfSameDate(ctx, stored, p);
        else writePlanned(ctx, stock, p, null);
      }
    }
    if (!sweepResult.complete) {
      recordSourceError(ctx.db, yahooSource(ctx, 'calendar'),
        `bulk calendar sweep (${region}) incomplete: ${sweepResult.rows.length} rows read`, ctx.now());
    }
  }
}
