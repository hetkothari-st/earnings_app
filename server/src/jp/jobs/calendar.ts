/**
 * Japan report dates (controller ruling of 2026-10-27, replacing the bulk-calendar design: Yahoo's bulk calendar
 * has had no Tokyo rows since May 2025).
 *
 * - `refreshJpCalendar`: a rolling per-symbol sweep of quoteSummary `calendarEvents` through the one Japan Yahoo
 *   client. Every listed code (with a fiscal year end) once a day; near-term codes (an unreleased report within
 *   14 days, or no date seen in the last 7 days) every 6 h. Each run takes at most `perRun` codes, longest overdue
 *   first; scheduled every 10 min with the default 30 that is about one request per 20 s. Progress is kept per code
 *   in `jp_date_sweep`, so a restart resumes the cycle, and codes never checked go first, those with no stored
 *   date ahead of the rest.
 * - `refreshJpBulkCalendar`: the bulk calendar, kept as a supplement only. It creates rows for periods that have
 *   none and supplies TAS timing; it never moves a stored date.
 *
 * Both: dates before today never create a row, nor do dates more than 120 days ahead; a stock without a fiscal year
 * end gets no row; full level merges the ADR's US row (Ruling 8: used when Yahoo agrees or has no date for that
 * period, nothing when they disagree); everything is written `estimated`, and the repo never lets an estimated
 * date move a confirmed one or a released row.
 */
import type { DatabaseSync } from 'node:sqlite';
import { usAdrRows } from '../../db/adrRows.js';
import { recordSourceError } from '../../db/repo.js';
import {
  findJpReportId, getJpReport, type JpStock, jpReportsBetween, jpStocks, setJpTiming, upsertJpCalendarRow, upsertJpPastDates,
} from '../db/jpRepo.js';
import { addDaysJST, jpDateFromUs, type JpTiming } from '../domain/jpCalendar.js';
import { type JpPeriod, jpPeriodFor, jpPeriodLabel } from '../domain/period.js';
import type { YahooCalRow } from '../sources/yahooJp.js';
import { trackIn, type JpJobContext } from './context.js';
import { applyJpSummary, jpEstimateRows } from './estimates.js';

const HOUR = 3_600_000;

export const JP_DATE_SWEEP = {
  /** Codes per run; with a 10-minute schedule about one request per 20 s (~5% of the 1 req/s Yahoo budget). */
  perRun: 30,
  everyMs: 10 * 60_000,
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

// ---------- Sweep progress ----------

function ensureSweepTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS jp_date_sweep (
    code TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL,   -- last calendarEvents fetch (or attempt)
    date_seen_at TEXT           -- last fetch that showed a single date today or later
  )`);
}

function sweepState(db: DatabaseSync): Map<string, { checkedAt: string; dateSeenAt: string | null }> {
  const rows = db.prepare('SELECT code, checked_at, date_seen_at FROM jp_date_sweep').all() as
    { code: string; checked_at: string; date_seen_at: string | null }[];
  return new Map(rows.map((r) => [r.code, { checkedAt: r.checked_at, dateSeenAt: r.date_seen_at }]));
}

function markChecked(db: DatabaseSync, code: string, now: string, dateSeen: boolean): void {
  db.prepare(`INSERT INTO jp_date_sweep (code, checked_at, date_seen_at) VALUES (?, ?, ?)
    ON CONFLICT (code) DO UPDATE SET checked_at = excluded.checked_at, date_seen_at = COALESCE(excluded.date_seen_at, date_seen_at)`)
    .run(code, now, dateSeen ? now : null);
}

// ---------- Date planning (shared) ----------

interface Candidate { date: string; timing: JpTiming; tas: boolean }
interface Planned extends Candidate { period: JpPeriod }

/**
 * The dates to write for one stock, one per fiscal period. Yahoo dates outside [today, today+120] are dropped; two
 * different Yahoo dates for one period are ambiguous and both dropped (Ruling 11). Full level: the ADR's US rows as
 * JST dates; per period, a US date is used when Yahoo agrees or has none, and nothing is written when they disagree.
 */
function planDates(ctx: JpJobContext, stock: JpStock, yahoo: Candidate[]): Planned[] {
  const fy = stock.fyEndMonth;
  if (fy == null) return [];
  const today = ctx.todayJST();
  const end = addDaysJST(today, AHEAD_DAYS);
  const inRange = (d: string) => d >= today && d <= end;

  const ys = new Map<string, { dates: Set<string>; best: Planned }>();
  for (const c of yahoo.filter((c) => inRange(c.date))) {
    const period = jpPeriodFor(c.date, fy);
    const e = ys.get(period.periodEnd);
    if (!e) { ys.set(period.periodEnd, { dates: new Set([c.date]), best: { ...c, period } }); continue; }
    e.dates.add(c.date);
    if (c.tas && !e.best.tas && c.date === e.best.date) e.best = { ...c, period };
  }

  const us = new Map<string, Planned>();
  if (stock.level === 'full' && stock.adr) {
    for (const u of usAdrRows(ctx.db, stock.adr, addDaysJST(today, -1), end)) {
      const date = jpDateFromUs(u.reportDate, u.timing);
      if (!inRange(date)) continue;
      const period = jpPeriodFor(date, fy);
      const have = us.get(period.periodEnd);
      if (!have || date < have.date) us.set(period.periodEnd, { date, timing: 'UNKNOWN', tas: false, period });
    }
  }

  const out: Planned[] = [];
  for (const periodEnd of new Set([...ys.keys(), ...us.keys()])) {
    const y = ys.get(periodEnd);
    const u = us.get(periodEnd);
    if (y && y.dates.size > 1) continue; // ambiguous
    if (y && u) { if (y.best.date === u.date) out.push(y.best); continue; }
    if (y) out.push(y.best);
    else if (u) out.push(u);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function writePlanned(ctx: JpJobContext, stock: JpStock, p: Planned): number {
  const id = upsertJpCalendarRow(ctx.db, {
    code: stock.code, name: stock.name, period: p.period, periodLabel: jpPeriodLabel(p.period), reportDate: p.date, dateStatus: 'estimated',
  }, ctx.now());
  timingIfSameDate(ctx, id, p);
  return id;
}

/** A TAS time sets the timing only when the stored row is on that very date (and its timing is still unknown). */
function timingIfSameDate(ctx: JpJobContext, id: number, p: Candidate): void {
  if (!p.tas || p.timing === 'UNKNOWN') return;
  if (getJpReport(ctx.db, id)?.reportDate === p.date) setJpTiming(ctx.db, id, p.timing, 'yahoo');
}

// ---------- Rolling per-symbol sweep ----------

/** The codes due now, in sweep order: never checked (no stored date first), then longest overdue. */
function dueCodes(ctx: JpJobContext, stocks: JpStock[]): JpStock[] {
  const today = ctx.todayJST();
  const nowMs = Date.parse(ctx.now());
  const state = sweepState(ctx.db);
  const withDate = new Set((ctx.db.prepare('SELECT DISTINCT code FROM jp_reports WHERE report_date >= ?').all(today) as { code: string }[])
    .map((r) => r.code));
  const nearTerm = new Set(jpReportsBetween(ctx.db, today, addDaysJST(today, JP_DATE_SWEEP.nearTermDays))
    .filter((r) => r.releasedAt == null && !r.hasEps).map((r) => r.code));

  const due: { stock: JpStock; rank: number; at: number }[] = [];
  for (const stock of stocks) {
    const st = state.get(stock.code);
    if (!st) { due.push({ stock, rank: withDate.has(stock.code) ? 1 : 0, at: 0 }); continue; }
    const noDate = st.dateSeenAt == null || Date.parse(st.dateSeenAt) < nowMs - JP_DATE_SWEEP.noDateMs;
    const interval = nearTerm.has(stock.code) || noDate ? JP_DATE_SWEEP.nearTermMs : JP_DATE_SWEEP.fullCycleMs;
    const at = Date.parse(st.checkedAt) + interval;
    if (at <= nowMs) due.push({ stock, rank: 2, at });
  }
  return due
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.stock.code.localeCompare(b.stock.code))
    .map((d) => d.stock);
}

/**
 * One run of the rolling date sweep (see the file comment). For each due code: a single next date today or later
 * is planned and written; a stale (past) date never creates a row, but is kept as a past date (for previous moves)
 * when it lies within 140 days and Yahoo's earningsHistory already has an actual for the period it closes; a range
 * gives nothing. The same summary also feeds estimates and sector / industry. A failed request records a
 * `yahoo-jp-calendar` error and ends the run: rows written so far stay, nothing is deleted, and the failed code
 * waits for its next turn so one bad symbol cannot stall the sweep.
 */
export async function refreshJpCalendar(ctx: JpJobContext, opts: { perRun?: number } = {}): Promise<void> {
  ensureSweepTable(ctx.db);
  const today = ctx.todayJST();
  const stocks = jpStocks(ctx.db).filter((s) => s.active && s.fyEndMonth != null);
  for (const stock of dueCodes(ctx, stocks).slice(0, Math.max(0, opts.perRun ?? JP_DATE_SWEEP.perRun))) {
    const y = await trackIn(ctx, 'yahoo-jp-calendar', () => ctx.yahooSummary(stock.yahooSymbol, JP_DATE_SWEEP.maxAgeMs));
    if (y === undefined) {
      markChecked(ctx.db, stock.code, ctx.now(), false);
      return;
    }
    const next = y?.nextDate ?? null;
    const seen = next != null && next >= today;
    for (const p of planDates(ctx, stock, seen ? [{ date: next, timing: 'UNKNOWN', tas: false }] : [])) writePlanned(ctx, stock, p);
    if (y && next != null && !seen) keepPastDate(ctx, stock, next, y.epsHistory);
    if (y) applyJpSummary(ctx, stock.code, jpEstimateRows(ctx, stock.code), y);
    markChecked(ctx.db, stock.code, ctx.now(), seen);
  }
}

function keepPastDate(ctx: JpJobContext, stock: JpStock, date: string, history: { periodEnd: string }[]): void {
  if (stock.fyEndMonth == null || date < addDaysJST(ctx.todayJST(), -PAST_DAYS)) return;
  const month = jpPeriodFor(date, stock.fyEndMonth).periodEnd.slice(0, 7);
  if (history.some((h) => h.periodEnd.slice(0, 7) === month)) upsertJpPastDates(ctx.db, [{ code: stock.code, date, timing: null }]);
}

// ---------- Bulk calendar supplement ----------

/**
 * The bulk calendar `[today, today+120]` as a supplement: a period with no stored row gets one (`estimated`), and a
 * TAS row on a stored row's own date sets its timing (`setJpTiming`, only while unknown). Stored dates are never
 * moved here (the per-symbol sweep owns them). An incomplete sweep writes what it got and records a
 * `yahoo-jp-calendar` error.
 */
export async function refreshJpBulkCalendar(ctx: JpJobContext): Promise<void> {
  const today = ctx.todayJST();
  const sweep = await trackIn(ctx, 'yahoo-jp-calendar', () => ctx.yahooCalendar(today, addDaysJST(today, AHEAD_DAYS)));
  if (!sweep) return;
  const byCode = new Map<string, YahooCalRow[]>();
  for (const r of sweep.rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
  for (const stock of jpStocks(ctx.db).filter((s) => s.active && byCode.has(s.code))) {
    const candidates = byCode.get(stock.code)!.map((r) => ({
      date: r.date, timing: r.timeType === 'TAS' ? r.timing : 'UNKNOWN' as JpTiming, tas: r.timeType === 'TAS',
    }));
    for (const p of planDates(ctx, stock, candidates)) {
      const stored = findJpReportId(ctx.db, stock.code, p.period.periodEnd);
      if (stored != null) timingIfSameDate(ctx, stored, p);
      else writePlanned(ctx, stock, p);
    }
  }
  if (!sweep.complete) {
    recordSourceError(ctx.db, 'yahoo-jp-calendar', `bulk calendar sweep incomplete: ${sweep.rows.length} rows read`, ctx.now());
  }
}
