import type { DatabaseSync } from 'node:sqlite';
import { normalizeTicker } from '../../domain/ticker.js';
import type { ExpectedMove } from '../../types.js';
import type { HkTiming } from '../domain/hkCalendar.js';
import type { HkPeriodKind } from '../domain/period.js';
import { hkLevel, type HkUniverseEntry, yahooHkSymbol } from '../universe.js';
import { HK_ADDED_COLUMNS, HK_SCHEMA } from './schema.js';

/** HK report ids start here, so they never collide with US ids or India ids (1_000_000_001). */
export const HK_ID_BASE = 2_000_000_001;

export function ensureHkSchema(db: DatabaseSync): void {
  db.exec(HK_SCHEMA);
  for (const [table, cols] of Object.entries(HK_ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

// ---------- Stocks ----------

export interface HkStock {
  code: string;
  name: string;
  yahooSymbol: string;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  cik: number | null;
  cadence: 'Q' | 'H';
  fyEndMonth: number;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  active: boolean;
}

/**
 * Upserts the universe. Codes no longer listed become inactive and keep their reports.
 * The universe name is always refreshed; a Yahoo name (`setHkProfile`) is kept apart and served in preference.
 */
export function syncHkUniverse(db: DatabaseSync, entries: readonly HkUniverseEntry[], now: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE hk_stocks SET active = 0').run();
    const up = db.prepare(`INSERT INTO hk_stocks (code, name, yahoo_symbol, level, adr, adr_ratio, cik, cadence, fy_end_month, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (code) DO UPDATE SET name = excluded.name, yahoo_symbol = excluded.yahoo_symbol, level = excluded.level, adr = excluded.adr,
        adr_ratio = excluded.adr_ratio, cik = excluded.cik, cadence = excluded.cadence, fy_end_month = excluded.fy_end_month,
        active = 1, updated_at = excluded.updated_at`);
    for (const e of entries) up.run(e.code, e.name, yahooHkSymbol(e.code), hkLevel(e), e.adr, e.adrRatio, e.cik, e.cadence, e.fyEndMonth, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Name / sector / market cap from Yahoo; a missing value never blanks a stored one. */
export function setHkProfile(
  db: DatabaseSync, code: string,
  p: { name: string | null; sector: string | null; industry: string | null; marketCap: number | null; asOf: string | null }, now: string,
): void {
  db.prepare(`UPDATE hk_stocks SET profile_name = COALESCE(?, profile_name), sector = COALESCE(?, sector), industry = COALESCE(?, industry),
      market_cap = COALESCE(?, market_cap), market_cap_as_of = COALESCE(?, market_cap_as_of),
      updated_at = ? WHERE code = ?`)
    .run(p.name?.trim() || null, p.sector, p.industry, p.marketCap, p.asOf, now, code);
}

interface StockRow {
  code: string; name: string; profile_name: string | null; yahoo_symbol: string; level: string; adr: string | null; adr_ratio: number | null; cik: number | null;
  cadence: string; fy_end_month: number; sector: string | null; industry: string | null; market_cap: number | null;
  market_cap_as_of: string | null; active: number;
}

export function hkStocks(db: DatabaseSync): HkStock[] {
  return (db.prepare('SELECT * FROM hk_stocks ORDER BY code').all() as unknown as StockRow[]).map((r) => ({
    code: r.code, name: r.profile_name ?? r.name, yahooSymbol: r.yahoo_symbol, level: r.level === 'full' ? 'full' : 'basic',
    adr: r.adr, adrRatio: r.adr_ratio, cik: r.cik, cadence: r.cadence === 'H' ? 'H' : 'Q', fyEndMonth: r.fy_end_month,
    sector: r.sector, industry: r.industry, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of, active: r.active === 1,
  }));
}

// ---------- Reports ----------

export interface HkReport {
  id: number;
  code: string;
  name: string;
  periodEnd: string;
  periodKind: HkPeriodKind;
  periodLabel: string;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  timing: HkTiming;
  timingSource: string | null;
  releasedAt: string | null;
  rescheduledFrom: string | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
  epsActual: number | null;
  epsCurrency: string | null;
  epsBasis: 'share' | 'ads' | null;
  actualSource: 'sec' | 'yahoo' | null;
  secDocUrl: string | null;
  epsEstimate: number | null;
  epsAnalysts: number | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  estimateCurrency: string | null;
  estimatesFetchedAt: string | null;
  prevMovePct: number | null;
  prevMoveDate: string | null;
  prevMoveBasis: 'known' | 'assumed' | null;
  prevMoveCheckedAt: string | null;
  calendarFetchedAt: string | null;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  expectedMove: (ExpectedMove & { adr: string; quoteDate: string; final: boolean; snapshotAt: string }) | null;
  liveMovePct: number | null;
  liveMoveIlliquid: boolean | null;
  liveMoveQuoteTime: string | null;
}

interface ReportRow {
  id: number; code: string; name: string; period_end: string; period_kind: string; period_label: string; report_date: string;
  date_status: string; timing: string; timing_source: string | null; released_at: string | null; rescheduled_from: string | null;
  revenue_actual: number | null; revenue_currency: string | null; eps_actual: number | null; eps_currency: string | null;
  eps_basis: string | null; actual_source: string | null; sec_doc_url: string | null;
  eps_estimate: number | null; eps_analysts: number | null; revenue_estimate: number | null; revenue_analysts: number | null;
  estimate_currency: string | null; estimates_fetched_at: string | null;
  prev_move_pct: number | null; prev_move_date: string | null; prev_move_basis: string | null; prev_move_checked_at: string | null;
  calendar_fetched_at: string | null;
  s_name: string; s_level: string; s_adr: string | null; s_adr_ratio: number | null; s_sector: string | null; s_industry: string | null;
  s_market_cap: number | null; s_market_cap_as_of: string | null;
  em_adr: string | null; em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_final: number | null;
  em_quote_date: string | null; em_snapshot_at: string | null;
  lm_move_pct: number | null; lm_illiquid: number | null; lm_quote_time: string | null;
}

const SELECT_COLUMNS = `
SELECT r.*,
  COALESCE(s.profile_name, s.name) AS s_name, s.level AS s_level, s.adr AS s_adr, s.adr_ratio AS s_adr_ratio, s.sector AS s_sector, s.industry AS s_industry,
  s.market_cap AS s_market_cap, s.market_cap_as_of AS s_market_cap_as_of,
  m.adr AS em_adr, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
  m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.final AS em_final,
  m.quote_date AS em_quote_date, m.snapshot_at AS em_snapshot_at,
  l.move_pct AS lm_move_pct, l.illiquid AS lm_illiquid, l.quote_time AS lm_quote_time
FROM hk_reports r
JOIN hk_stocks s ON s.code = r.code`;
const SELECT_JOINS = `
LEFT JOIN hk_expected_moves m ON m.report_id = r.id
LEFT JOIN hk_live_moves l ON l.report_id = r.id`;
/** The calendar shows only stocks in the current universe. */
const SELECT_ACTIVE = `${SELECT_COLUMNS} AND s.active = 1${SELECT_JOINS}`;
/** Any stock with reports (watchlists). */
const SELECT_ANY = `${SELECT_COLUMNS}${SELECT_JOINS}`;

function toHkReport(r: ReportRow): HkReport {
  return {
    id: r.id,
    code: r.code,
    name: r.s_name,
    periodEnd: r.period_end,
    periodKind: r.period_kind as HkPeriodKind,
    periodLabel: r.period_label,
    reportDate: r.report_date,
    dateStatus: r.date_status === 'confirmed' ? 'confirmed' : 'estimated',
    timing: r.timing as HkTiming,
    timingSource: r.timing_source,
    releasedAt: r.released_at,
    rescheduledFrom: r.rescheduled_from,
    revenueActual: r.revenue_actual,
    revenueCurrency: r.revenue_currency,
    epsActual: r.eps_actual,
    epsCurrency: r.eps_currency,
    epsBasis: r.eps_basis === 'share' || r.eps_basis === 'ads' ? r.eps_basis : null,
    actualSource: r.actual_source === 'sec' || r.actual_source === 'yahoo' ? r.actual_source : null,
    secDocUrl: r.sec_doc_url,
    epsEstimate: r.eps_estimate,
    epsAnalysts: r.eps_analysts,
    revenueEstimate: r.revenue_estimate,
    revenueAnalysts: r.revenue_analysts,
    estimateCurrency: r.estimate_currency,
    estimatesFetchedAt: r.estimates_fetched_at,
    prevMovePct: r.prev_move_pct,
    prevMoveDate: r.prev_move_date,
    prevMoveBasis: r.prev_move_basis === 'known' || r.prev_move_basis === 'assumed' ? r.prev_move_basis : null,
    prevMoveCheckedAt: r.prev_move_checked_at,
    calendarFetchedAt: r.calendar_fetched_at,
    level: r.s_level === 'full' ? 'full' : 'basic',
    adr: r.s_adr,
    adrRatio: r.s_adr_ratio,
    sector: r.s_sector,
    industry: r.s_industry,
    marketCap: r.s_market_cap,
    marketCapAsOf: r.s_market_cap_as_of,
    expectedMove: r.em_snapshot_at
      ? {
          adr: r.em_adr ?? r.s_adr ?? '',
          expiry: r.em_expiry!,
          strike: r.em_strike!,
          callMid: r.em_call_mid!,
          putMid: r.em_put_mid!,
          underlying: r.em_underlying!,
          movePct: r.em_move_pct!,
          illiquid: r.em_illiquid === 1,
          final: r.em_final === 1,
          quoteDate: r.em_quote_date ?? '',
          snapshotAt: r.em_snapshot_at,
        }
      : null,
    liveMovePct: r.lm_move_pct,
    liveMoveIlliquid: r.lm_illiquid != null ? r.lm_illiquid === 1 : null,
    liveMoveQuoteTime: r.lm_quote_time,
  };
}

const findReport = (db: DatabaseSync, code: string, periodEnd: string) =>
  db.prepare('SELECT * FROM hk_reports WHERE code = ? AND period_end = ?').get(code, periodEnd) as unknown as ReportRow | undefined;

const properName = (name: string, code: string) => (name.trim() && name.trim() !== code ? name.trim() : null);

/**
 * A report date for a period. Confirmed dates (from a filing notice) never give way to estimated ones.
 * Once results are out the date is fixed. A new confirmed date for an unreleased row is a reschedule:
 * the old date is kept in rescheduled_from and timing goes back to unknown. Returns the report id.
 */
export function upsertHkCalendarRow(
  db: DatabaseSync,
  row: {
    code: string; name: string; periodEnd: string; periodKind: HkPeriodKind; periodLabel: string; reportDate: string;
    dateStatus: 'confirmed' | 'estimated'; timing?: HkTiming; timingSource?: string;
  },
  now: string,
): number {
  const timing = row.timing ?? 'UNKNOWN';
  const source = timing === 'UNKNOWN' ? null : row.timingSource ?? null;
  const existing = findReport(db, row.code, row.periodEnd);
  if (!existing) {
    const r = db.prepare(`INSERT INTO hk_reports (id, code, name, period_end, period_kind, period_label, report_date, date_status,
        timing, timing_source, calendar_fetched_at)
      VALUES ((SELECT max(COALESCE(MAX(id), 0) + 1, ?) FROM hk_reports), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(HK_ID_BASE, row.code, row.name, row.periodEnd, row.periodKind, row.periodLabel, row.reportDate, row.dateStatus,
        timing, source, now) as { id: number };
    return r.id;
  }

  const name = properName(row.name, row.code) ?? existing.name;
  const released = existing.released_at != null || existing.eps_actual != null;
  const weaker = row.dateStatus === 'estimated' && existing.date_status === 'confirmed';
  if (released || weaker || existing.report_date === row.reportDate) {
    // A confirmed notice for the date that was estimated confirms it.
    const confirms = !released && existing.report_date === row.reportDate && row.dateStatus === 'confirmed';
    const status = confirms ? 'confirmed' : existing.date_status;
    // Timing from a notice on the same date fills an unknown timing of an unreleased row.
    const setTiming = !released && !weaker && timing !== 'UNKNOWN' && existing.timing === 'UNKNOWN';
    db.prepare('UPDATE hk_reports SET name = ?, date_status = ?, timing = ?, timing_source = ?, calendar_fetched_at = ? WHERE id = ?')
      .run(name, status, setTiming ? timing : existing.timing, setTiming ? source : existing.timing_source, now, existing.id);
    return existing.id;
  }
  db.prepare(`UPDATE hk_reports SET name = ?, report_date = ?, date_status = ?, timing = ?, timing_source = ?,
      rescheduled_from = CASE WHEN ? = 'confirmed' THEN ? ELSE rescheduled_from END, calendar_fetched_at = ? WHERE id = ?`)
    .run(name, row.reportDate, row.dateStatus, timing, source, existing.date_status, existing.report_date, now, existing.id);
  db.prepare('DELETE FROM hk_expected_moves WHERE report_id = ?').run(existing.id);
  db.prepare('DELETE FROM hk_live_moves WHERE report_id = ?').run(existing.id);
  return existing.id;
}

/**
 * The moment results were made public (SEC acceptance). The earliest one wins. `timing` (a proven BMO, or a
 * stated one) is written only when non-null. Returns true if anything was written.
 */
export function recordHkRelease(db: DatabaseSync, id: number, releasedAt: string, source: 'sec-6k' | 'sec-8k', timing: HkTiming | null): boolean {
  const r = db.prepare('SELECT released_at FROM hk_reports WHERE id = ?').get(id) as { released_at: string | null } | undefined;
  if (!r) return false;
  if (r.released_at && Date.parse(r.released_at) <= Date.parse(releasedAt)) return false;
  if (timing) db.prepare('UPDATE hk_reports SET released_at = ?, timing = ?, timing_source = ? WHERE id = ?').run(releasedAt, timing, source, id);
  else db.prepare('UPDATE hk_reports SET released_at = ? WHERE id = ?').run(releasedAt, id);
  return true;
}

/** The unreleased report of `code` (any period) dated nearest to `day`, within `windowDays` calendar days. */
export function nearestUnreleasedHk(
  db: DatabaseSync, code: string, day: string, windowDays = 3,
): { id: number; reportDate: string; periodEnd: string; periodKind: HkPeriodKind } | null {
  const r = db.prepare(`SELECT id, report_date AS reportDate, period_end AS periodEnd, period_kind AS periodKind FROM hk_reports
    WHERE code = ? AND released_at IS NULL AND eps_actual IS NULL AND abs(julianday(report_date) - julianday(?)) <= ?
    ORDER BY abs(julianday(report_date) - julianday(?)), report_date LIMIT 1`).get(code, day, windowDays, day) as
    { id: number; reportDate: string; periodEnd: string; periodKind: HkPeriodKind } | undefined;
  return r ?? null;
}

export function findHkReportId(db: DatabaseSync, code: string, periodEnd: string): number | null {
  return findReport(db, code, periodEnd)?.id ?? null;
}

/** The report came out on another day than the calendar said: the old date is kept, timing and move snapshots reset. */
export function moveHkReportDate(db: DatabaseSync, id: number, newDate: string): void {
  db.prepare(`UPDATE hk_reports SET rescheduled_from = report_date, report_date = ?, timing = 'UNKNOWN', timing_source = NULL
      WHERE id = ? AND report_date IS NOT ?`).run(newDate, id, newDate);
  db.prepare('DELETE FROM hk_expected_moves WHERE report_id = ?').run(id);
  db.prepare('DELETE FROM hk_live_moves WHERE report_id = ?').run(id);
}

/** Writes timing only while it is unknown and the row is unreleased. */
export function setHkTiming(db: DatabaseSync, id: number, timing: HkTiming, source: 'yahoo'): boolean {
  if (timing === 'UNKNOWN') return false;
  const r = db.prepare(`UPDATE hk_reports SET timing = ?, timing_source = ?
    WHERE id = ? AND timing = 'UNKNOWN' AND released_at IS NULL AND eps_actual IS NULL`).run(timing, source, id);
  return Number(r.changes) > 0;
}

/**
 * Actuals. A missing figure never blanks a stored one; Yahoo never replaces SEC, SEC replaces Yahoo.
 * Returns true if anything changed.
 */
export function mergeHkActuals(
  db: DatabaseSync, id: number,
  a: {
    revenue: number | null; revenueCurrency: string | null; eps: number | null; epsCurrency: string | null;
    epsBasis: 'share' | 'ads' | null; source: 'sec' | 'yahoo'; docUrl?: string | null;
  },
  _now: string,
): boolean {
  const r = db.prepare(`SELECT revenue_actual, revenue_currency, eps_actual, eps_currency, eps_basis, actual_source, sec_doc_url
    FROM hk_reports WHERE id = ?`).get(id) as
    { revenue_actual: number | null; revenue_currency: string | null; eps_actual: number | null; eps_currency: string | null;
      eps_basis: string | null; actual_source: string | null; sec_doc_url: string | null } | undefined;
  if (!r) return false;
  if (a.source === 'yahoo' && r.actual_source === 'sec') return false;
  // A new figure carries exactly the currency / basis it came with (uncertain means blank), never the old row's.
  const next = {
    revenue: a.revenue ?? r.revenue_actual,
    revenueCurrency: a.revenue != null ? a.revenueCurrency : r.revenue_currency,
    eps: a.eps ?? r.eps_actual,
    epsCurrency: a.eps != null ? a.epsCurrency : r.eps_currency,
    epsBasis: a.eps != null ? a.epsBasis : r.eps_basis,
    docUrl: a.docUrl ?? r.sec_doc_url,
  };
  // The source follows the data: SEC data (even identical to Yahoo's) makes the row SEC-sourced.
  const gives = a.revenue != null || a.eps != null;
  const source = gives ? a.source : r.actual_source;
  const changed = next.revenue !== r.revenue_actual || next.revenueCurrency !== r.revenue_currency || next.eps !== r.eps_actual
    || next.epsCurrency !== r.eps_currency || next.epsBasis !== r.eps_basis || next.docUrl !== r.sec_doc_url
    || source !== r.actual_source;
  if (!changed) return false;
  db.prepare(`UPDATE hk_reports SET revenue_actual = ?, revenue_currency = ?, eps_actual = ?, eps_currency = ?, eps_basis = ?,
      actual_source = ?, sec_doc_url = ? WHERE id = ?`)
    .run(next.revenue, next.revenueCurrency, next.eps, next.epsCurrency, next.epsBasis, source, next.docUrl, id);
  return true;
}

export function setHkEstimates(
  db: DatabaseSync, id: number,
  e: { eps: number | null; epsAnalysts: number | null; revenue: number | null; revenueAnalysts: number | null; currency: string | null }, now: string,
): void {
  db.prepare(`UPDATE hk_reports SET eps_estimate = COALESCE(?, eps_estimate), eps_analysts = COALESCE(?, eps_analysts),
      revenue_estimate = COALESCE(?, revenue_estimate), revenue_analysts = COALESCE(?, revenue_analysts),
      estimate_currency = COALESCE(?, estimate_currency), estimates_fetched_at = ? WHERE id = ?`)
    .run(e.eps, e.epsAnalysts, e.revenue, e.revenueAnalysts, e.currency, now, id);
}

// ---------- Lists ----------

export function listHkRange(db: DatabaseSync, f: { from: string; to: string; q: string | null }): HkReport[] {
  const where = ['r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [f.from, f.to];
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.code LIKE ? OR r.name LIKE ? OR s.adr LIKE ?)');
    params.push(`${term}%`, `%${term}%`, `${term.toUpperCase()}%`);
  }
  const rows = db.prepare(`${SELECT_ACTIVE} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.code`)
    .all(...params) as unknown as ReportRow[];
  return rows.map(toHkReport);
}

/** Reports of the given codes dated in [from, to], in the universe or not (watchlists). */
export function listHkForSymbols(db: DatabaseSync, codes: string[], from: string, to: string): HkReport[] {
  if (codes.length === 0) return [];
  const rows = db.prepare(`${SELECT_ANY} WHERE r.code IN (${codes.map(() => '?').join(',')}) AND r.report_date BETWEEN ? AND ?
      ORDER BY r.report_date, r.code`).all(...codes, from, to) as unknown as ReportRow[];
  return rows.map(toHkReport);
}

export function getHkReport(db: DatabaseSync, id: number): HkReport | undefined {
  const r = db.prepare(`${SELECT_ANY} WHERE r.id = ?`).get(id) as unknown as ReportRow | undefined;
  return r && toHkReport(r);
}

// ---------- Moves ----------

/** An ADR straddle snapshot. A final one (taken at the last US close before release) is never replaced. */
export function saveHkExpectedMove(
  db: DatabaseSync, id: number, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now: string,
): boolean {
  const prev = db.prepare('SELECT final FROM hk_expected_moves WHERE report_id = ?').get(id) as { final: number } | undefined;
  if (prev?.final === 1) return false;
  db.prepare(`INSERT OR REPLACE INTO hk_expected_moves
    (report_id, adr, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, final, quote_date, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, em.adr, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, final ? 1 : 0, em.quoteDate, now,
  );
  return true;
}

export function saveHkLiveMove(
  db: DatabaseSync, id: number, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now: string,
): boolean {
  const prev = db.prepare('SELECT move_pct AS p FROM hk_live_moves WHERE report_id = ?').get(id) as { p: number } | undefined;
  db.prepare(`INSERT OR REPLACE INTO hk_live_moves (report_id, move_pct, illiquid, quote_time, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, m.movePct, m.illiquid ? 1 : 0, m.quoteTime, now);
  return prev?.p !== m.movePct;
}

/** Records a check; a found move is stored, a miss never blanks an earlier value. */
export function setHkPrevMove(
  db: DatabaseSync, id: number, move: { pct: number; date: string; basis: 'known' | 'assumed' } | null, now: string,
): void {
  if (move) {
    db.prepare('UPDATE hk_reports SET prev_move_pct = ?, prev_move_date = ?, prev_move_basis = ?, prev_move_checked_at = ? WHERE id = ?')
      .run(move.pct, move.date, move.basis, now, id);
  } else {
    db.prepare('UPDATE hk_reports SET prev_move_checked_at = ? WHERE id = ?').run(now, id);
  }
}

// ---------- Job queries ----------

export interface HkPending {
  id: number;
  code: string;
  reportDate: string;
  timing: HkTiming;
  periodEnd: string;
  periodKind: HkPeriodKind;
  releasedAt: string | null;
  level: 'full' | 'basic';
  adr: string | null;
  cik: number | null;
  hasActual: boolean;
  expectedFinal: boolean;
}

/** Reports of universe stocks dated in the range. */
export function hkReportsBetween(db: DatabaseSync, from: string, to: string): HkPending[] {
  const rows = db.prepare(`SELECT r.id, r.code, r.report_date AS reportDate, r.timing, r.period_end AS periodEnd,
      r.period_kind AS periodKind, r.released_at AS releasedAt, s.level, s.adr, s.cik,
      (r.eps_actual IS NOT NULL OR r.revenue_actual IS NOT NULL) AS hasActual, COALESCE(m.final, 0) AS expectedFinal
    FROM hk_reports r JOIN hk_stocks s ON s.code = r.code AND s.active = 1
    LEFT JOIN hk_expected_moves m ON m.report_id = r.id
    WHERE r.report_date BETWEEN ? AND ? ORDER BY r.report_date, r.code`).all(from, to) as unknown as
    (Omit<HkPending, 'hasActual' | 'expectedFinal' | 'level'> & { level: string; hasActual: number; expectedFinal: number })[];
  return rows.map((r) => ({ ...r, level: r.level === 'full' ? 'full' : 'basic', hasActual: r.hasActual === 1, expectedFinal: r.expectedFinal === 1 }));
}

/** Reports with no previous move yet, not checked since `recheckBefore`. */
export function hkReportsNeedingPrevMove(
  db: DatabaseSync, from: string, to: string, recheckBefore: string,
): { id: number; code: string; reportDate: string; timing: HkTiming }[] {
  return db.prepare(`SELECT r.id, r.code, r.report_date AS reportDate, r.timing FROM hk_reports r
    JOIN hk_stocks s ON s.code = r.code AND s.active = 1
    WHERE r.report_date BETWEEN ? AND ? AND r.prev_move_pct IS NULL
      AND (r.prev_move_checked_at IS NULL OR r.prev_move_checked_at < ?)`)
    .all(from, to, recheckBefore) as unknown as { id: number; code: string; reportDate: string; timing: HkTiming }[];
}

/** The latest earlier report of `code` whose results are out. */
export function priorHkReleased(db: DatabaseSync, code: string, before: string): { reportDate: string; timing: HkTiming; known: boolean } | null {
  const r = db.prepare(`SELECT report_date, timing, released_at FROM hk_reports
    WHERE code = ? AND report_date < ? AND (released_at IS NOT NULL OR eps_actual IS NOT NULL)
    ORDER BY report_date DESC LIMIT 1`).get(code, before) as { report_date: string; timing: string; released_at: string | null } | undefined;
  return r ? { reportDate: r.report_date, timing: r.timing as HkTiming, known: r.released_at != null && r.timing !== 'UNKNOWN' } : null;
}

/** The ADR's rows in the US `reports` table (read-only), for converting to HK dates. */
export function usAdrRows(
  db: DatabaseSync, adr: string, from: string, to: string,
): { reportDate: string; timing: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN' }[] {
  return db.prepare(`SELECT report_date AS reportDate, timing FROM reports
    WHERE symbol_key = ? AND report_date BETWEEN ? AND ? ORDER BY report_date`)
    .all(normalizeTicker(adr), from, to) as unknown as { reportDate: string; timing: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN' }[];
}

// ---------- SEC bookkeeping ----------

export function secSeen(db: DatabaseSync, accession: string): boolean {
  return db.prepare('SELECT 1 FROM hk_sec_seen WHERE accession = ?').get(accession) != null;
}

export function markSecSeen(db: DatabaseSync, accession: string, cik: number | null, kind: 'results' | 'date-notice' | 'other', now: string): void {
  db.prepare('INSERT OR IGNORE INTO hk_sec_seen (accession, cik, kind, seen_at) VALUES (?, ?, ?, ?)').run(accession, cik, kind, now);
}

export function lastSecSeenAt(db: DatabaseSync): string | null {
  const r = db.prepare('SELECT MAX(seen_at) AS t FROM hk_sec_seen').get() as { t: string | null };
  return r.t;
}
