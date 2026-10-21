import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import { IN_ADDED_COLUMNS, IN_SCHEMA } from './schema.js';
import { IST, type InTiming, timingForRelease } from '../domain/nseCalendar.js';
import type { InExpectedMove } from '../domain/inMoves.js';
import { quarterLabel } from '../domain/quarter.js';

/** India report ids start here, so they never collide with US report ids (notes, live events). */
export const IN_ID_BASE = 1_000_000_001;

export function ensureInSchema(db: DatabaseSync): void {
  db.exec(IN_SCHEMA);
  for (const [table, cols] of Object.entries(IN_ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  // Early builds stored labels like "Sep/9"; the label always follows from the quarter end.
  const bad = db.prepare(`SELECT id, quarter_end FROM in_reports WHERE quarter_label NOT GLOB '[A-Z][a-z][a-z]/[0-9][0-9][0-9][0-9]'`)
    .all() as { id: number; quarter_end: string }[];
  for (const b of bad) db.prepare('UPDATE in_reports SET quarter_label = ? WHERE id = ?').run(quarterLabel(b.quarter_end), b.id);
  // Early builds numbered India reports from 1, colliding with US ids. Move them above the base;
  // their option snapshots are dropped (the next snapshot run takes them again).
  const low = db.prepare('SELECT COUNT(*) AS n FROM in_reports WHERE id < ?').get(IN_ID_BASE) as { n: number };
  if (low.n > 0) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM in_expected_moves WHERE report_id < ?').run(IN_ID_BASE);
      db.prepare('DELETE FROM in_live_moves WHERE report_id < ?').run(IN_ID_BASE);
      db.prepare('UPDATE in_reports SET id = id + ? WHERE id < ?').run(IN_ID_BASE - 1, IN_ID_BASE);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ---------- F&O stocks ----------

export interface InStock {
  symbol: string;
  name: string;
  lotSize: number | null;
  eqToken: number | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
}

/** Replaces the active F&O list. Stocks that left the list keep their history but are hidden. */
export function saveFoList(db: DatabaseSync, stocks: { symbol: string; name: string; lotSize: number }[], now: string): void {
  if (stocks.length === 0) return;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE in_stocks SET active = 0').run();
    const up = db.prepare(`INSERT INTO in_stocks (symbol, name, lot_size, active, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (symbol) DO UPDATE SET name = excluded.name, lot_size = excluded.lot_size, active = 1, updated_at = excluded.updated_at`);
    for (const s of stocks) up.run(s.symbol, s.name, s.lotSize, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setEqTokens(db: DatabaseSync, tokens: Map<string, number>): void {
  const up = db.prepare('UPDATE in_stocks SET eq_token = ? WHERE symbol = ?');
  for (const [symbol, token] of tokens) up.run(token, symbol);
}

/** Sector / market cap from Yahoo; a missing value never blanks a stored one. */
export function setStockProfile(
  db: DatabaseSync, symbol: string,
  p: { sector: string | null; industry: string | null; marketCap: number | null; asOf: string | null }, now: string,
): void {
  db.prepare(`UPDATE in_stocks SET sector = COALESCE(?, sector), industry = COALESCE(?, industry),
      market_cap = COALESCE(?, market_cap), market_cap_as_of = CASE WHEN ? IS NULL THEN market_cap_as_of ELSE ? END,
      updated_at = ? WHERE symbol = ?`)
    .run(p.sector, p.industry, p.marketCap, p.marketCap, p.asOf, now, symbol);
}

interface StockRow {
  symbol: string; name: string; lot_size: number | null; eq_token: number | null; sector: string | null;
  industry: string | null; market_cap: number | null; market_cap_as_of: string | null;
}
const toStock = (r: StockRow): InStock => ({
  symbol: r.symbol, name: r.name, lotSize: r.lot_size, eqToken: r.eq_token, sector: r.sector,
  industry: r.industry, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of,
});

export function activeStocks(db: DatabaseSync): InStock[] {
  return (db.prepare('SELECT * FROM in_stocks WHERE active = 1 ORDER BY symbol').all() as unknown as StockRow[]).map(toStock);
}

// ---------- Reports ----------

export interface InReport {
  id: number;
  symbol: string;
  name: string;
  quarterEnd: string;
  quarterLabel: string;
  reportDate: string | null;
  dateStatus: 'confirmed' | 'estimated';
  timing: InTiming;
  timingSource: string | null;
  releasedAt: string | null;
  rescheduledFrom: string | null;
  revenueActual: number | null;
  revenueKind: string | null;
  pnlActual: number | null;
  epsActual: number | null;
  nature: string | null;
  epsEstimate: number | null;
  epsAnalysts: number | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  prevMovePct: number | null;
  prevMoveDate: string | null;
  prevMoveBasis: 'known' | 'assumed' | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  expectedMove: (InExpectedMove & { final: boolean; snapshotAt: string }) | null;
  liveMovePct: number | null;
  liveMoveIlliquid: boolean | null;
  liveMoveQuoteTime: string | null;
}

interface InReportRow {
  id: number; symbol: string; name: string; quarter_end: string; quarter_label: string;
  report_date: string | null; date_status: string; timing: string; timing_source: string | null; released_at: string | null;
  rescheduled_from: string | null; revenue_actual: number | null; revenue_kind: string | null;
  pnl_actual: number | null; eps_actual: number | null; nature: string | null;
  eps_estimate: number | null; eps_analysts: number | null; revenue_estimate: number | null; revenue_analysts: number | null;
  prev_move_pct: number | null; prev_move_date: string | null; prev_move_basis: string | null;
  s_sector: string | null; s_industry: string | null; s_market_cap: number | null; s_market_cap_as_of: string | null;
  em_expiry: string | null; em_strike: number | null; em_call_mid: number | null;
  em_put_mid: number | null; em_underlying: number | null; em_move_pct: number | null;
  em_illiquid: number | null; em_final: number | null; em_snapshot_at: string | null;
  lm_move_pct: number | null; lm_illiquid: number | null; lm_quote_time: string | null;
}

/** Only stocks in the current F&O list are shown. */
const SELECT_IN = `
SELECT r.*,
  s.sector AS s_sector, s.industry AS s_industry, s.market_cap AS s_market_cap, s.market_cap_as_of AS s_market_cap_as_of,
  m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
  m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.final AS em_final,
  m.snapshot_at AS em_snapshot_at,
  l.move_pct AS lm_move_pct, l.illiquid AS lm_illiquid, l.quote_time AS lm_quote_time
FROM in_reports r
JOIN in_stocks s ON s.symbol = r.symbol AND s.active = 1
LEFT JOIN in_expected_moves m ON m.report_id = r.id
LEFT JOIN in_live_moves l ON l.report_id = r.id`;

function toInReport(r: InReportRow): InReport {
  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    quarterEnd: r.quarter_end,
    quarterLabel: r.quarter_label,
    reportDate: r.report_date,
    dateStatus: r.date_status === 'estimated' ? 'estimated' : 'confirmed',
    timing: r.timing as InTiming,
    timingSource: r.timing_source,
    releasedAt: r.released_at,
    rescheduledFrom: r.rescheduled_from,
    revenueActual: r.revenue_actual,
    revenueKind: r.revenue_kind,
    pnlActual: r.pnl_actual,
    epsActual: r.eps_actual,
    nature: r.nature,
    epsEstimate: r.eps_estimate,
    epsAnalysts: r.eps_analysts,
    revenueEstimate: r.revenue_estimate,
    revenueAnalysts: r.revenue_analysts,
    prevMovePct: r.prev_move_pct,
    prevMoveDate: r.prev_move_date,
    prevMoveBasis: r.prev_move_basis === 'known' || r.prev_move_basis === 'assumed' ? r.prev_move_basis : null,
    sector: r.s_sector,
    industry: r.s_industry,
    marketCap: r.s_market_cap,
    marketCapAsOf: r.s_market_cap_as_of,
    expectedMove: r.em_snapshot_at
      ? {
          symbol: r.symbol,
          expiry: r.em_expiry!,
          strike: r.em_strike!,
          callMid: r.em_call_mid!,
          putMid: r.em_put_mid!,
          underlying: r.em_underlying!,
          movePct: r.em_move_pct!,
          illiquid: r.em_illiquid === 1,
          final: r.em_final === 1,
          snapshotAt: r.em_snapshot_at,
        }
      : null,
    liveMovePct: r.lm_move_pct,
    liveMoveIlliquid: r.lm_illiquid != null ? r.lm_illiquid === 1 : null,
    liveMoveQuoteTime: r.lm_quote_time,
  };
}

function insertReport(
  db: DatabaseSync, row: { symbol: string; name: string; quarterEnd: string; quarterLabel: string; reportDate: string; dateStatus: string },
  now: string,
): number {
  const r = db.prepare(`INSERT INTO in_reports (id, symbol, name, quarter_end, quarter_label, report_date, date_status, calendar_fetched_at)
      VALUES ((SELECT max(COALESCE(MAX(id), 0) + 1, ?) FROM in_reports), ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(IN_ID_BASE, row.symbol, row.name, row.quarterEnd, row.quarterLabel, row.reportDate, row.dateStatus, now) as { id: number };
  return r.id;
}

const findReport = (db: DatabaseSync, symbol: string, quarterEnd: string) =>
  db.prepare('SELECT * FROM in_reports WHERE symbol = ? AND quarter_end = ?').get(symbol, quarterEnd) as unknown as InReportRow | undefined;

/** A name worth keeping: a real company name, not just the symbol again. */
const properName = (name: string, symbol: string) => (name.trim() && name.trim().toUpperCase() !== symbol ? name.trim() : null);

/**
 * A result date for a quarter. NSE notices are 'confirmed'; Yahoo dates are 'estimated' and never
 * replace a confirmed one. Once results are out the date is fixed. A newer notice with another date
 * is a reschedule: the old date is kept in rescheduled_from and timing goes back to unknown.
 */
export function upsertInCalendarRow(
  db: DatabaseSync,
  row: { symbol: string; name: string; quarterEnd: string; quarterLabel: string; reportDate: string; dateStatus?: 'confirmed' | 'estimated' },
  now: string,
): number {
  const dateStatus = row.dateStatus ?? 'confirmed';
  const existing = findReport(db, row.symbol, row.quarterEnd);
  if (!existing) return insertReport(db, { ...row, dateStatus }, now);

  const name = properName(row.name, row.symbol) ?? existing.name;
  const released = existing.released_at != null || existing.eps_actual != null;
  const weaker = dateStatus === 'estimated' && existing.date_status === 'confirmed';
  if (released || weaker || existing.report_date === row.reportDate) {
    // An NSE notice for the date Yahoo estimated confirms it.
    const status = !released && existing.report_date === row.reportDate && dateStatus === 'confirmed' ? 'confirmed' : existing.date_status;
    db.prepare('UPDATE in_reports SET name = ?, date_status = ?, calendar_fetched_at = ? WHERE id = ?').run(name, status, now, existing.id);
    return existing.id;
  }
  db.prepare(`UPDATE in_reports SET name = ?, report_date = ?, date_status = ?, timing = 'UNKNOWN', timing_source = NULL,
      rescheduled_from = CASE WHEN ? = 'confirmed' THEN ? ELSE rescheduled_from END, calendar_fetched_at = ? WHERE id = ?`)
    .run(name, row.reportDate, dateStatus, existing.date_status, existing.report_date, now, existing.id);
  db.prepare('DELETE FROM in_expected_moves WHERE report_id = ?').run(existing.id);
  db.prepare('DELETE FROM in_live_moves WHERE report_id = ?').run(existing.id);
  return existing.id;
}

/**
 * Financial results from an integrated filing. Consolidated actuals win and are never replaced by
 * standalone ones; a missing figure never blanks a stored one. The filing's board-meeting date is
 * the confirmed result date. Returns the report id and whether any actual changed.
 */
export function mergeInFiling(
  db: DatabaseSync,
  row: {
    symbol: string; name: string; quarterEnd: string; quarterLabel: string; reportDate: string;
    revenueActual: number | null; revenueKind: string | null; pnlActual: number | null; epsActual: number | null;
    nature: 'Standalone' | 'Consolidated';
  },
  now: string,
): { id: number; changed: boolean } {
  let existing = findReport(db, row.symbol, row.quarterEnd);
  if (!existing) {
    insertReport(db, { ...row, dateStatus: 'confirmed' }, now);
    existing = findReport(db, row.symbol, row.quarterEnd)!;
  }
  const take = row.nature === 'Consolidated' || existing.nature !== 'Consolidated';
  const next = {
    revenue: take ? row.revenueActual ?? existing.revenue_actual : existing.revenue_actual,
    kind: take && row.revenueActual != null ? row.revenueKind : existing.revenue_kind,
    pnl: take ? row.pnlActual ?? existing.pnl_actual : existing.pnl_actual,
    eps: take ? row.epsActual ?? existing.eps_actual : existing.eps_actual,
    nature: take ? row.nature : existing.nature,
  };
  const changed = next.revenue !== existing.revenue_actual || next.pnl !== existing.pnl_actual
    || next.eps !== existing.eps_actual || next.nature !== existing.nature;
  const moved = existing.report_date !== row.reportDate && existing.released_at == null;
  db.prepare(`UPDATE in_reports SET name = ?, report_date = ?, date_status = 'confirmed',
      rescheduled_from = CASE WHEN ? THEN report_date ELSE rescheduled_from END,
      revenue_actual = ?, revenue_kind = ?, pnl_actual = ?, eps_actual = ?, nature = ?, filing_fetched_at = ? WHERE id = ?`)
    .run(properName(row.name, row.symbol) ?? existing.name, moved ? row.reportDate : existing.report_date ?? row.reportDate,
      moved && existing.date_status === 'confirmed' && existing.report_date != null ? 1 : 0,
      next.revenue, next.kind, next.pnl, next.eps, next.nature, now, existing.id);
  return { id: existing.id, changed };
}

/**
 * The moment results were made public (an NSE announcement or filing). The earliest one wins;
 * timing follows from it relative to the result date. Returns true if timing changed.
 */
export function recordRelease(db: DatabaseSync, id: number, releasedAt: string, source: string): boolean {
  const r = db.prepare('SELECT report_date, timing, released_at FROM in_reports WHERE id = ?').get(id) as
    { report_date: string | null; timing: string; released_at: string | null } | undefined;
  if (!r?.report_date) return false;
  if (r.released_at && Date.parse(r.released_at) <= Date.parse(releasedAt)) return false;
  const timing = timingForRelease(r.report_date, DateTime.fromISO(releasedAt, { zone: IST }));
  if (!timing) return false; // the item is not this report's release (wrong day)
  db.prepare('UPDATE in_reports SET released_at = ?, timing = ?, timing_source = ? WHERE id = ?').run(releasedAt, timing, source, id);
  return timing !== r.timing;
}

export function findInReportId(db: DatabaseSync, symbol: string, quarterEnd: string): number | null {
  return findReport(db, symbol, quarterEnd)?.id ?? null;
}

/** The report of `symbol` dated `date`, if any. */
export function reportOnDate(db: DatabaseSync, symbol: string, date: string): number | null {
  const r = db.prepare('SELECT id FROM in_reports WHERE symbol = ? AND report_date = ?').get(symbol, date) as { id: number } | undefined;
  return r?.id ?? null;
}

/** The unreleased report of `symbol` (any quarter) dated nearest to `day`, within `windowDays` calendar days. */
export function nearestUnreleasedReport(db: DatabaseSync, symbol: string, day: string, windowDays = 3): { id: number; reportDate: string } | null {
  const r = db.prepare(`SELECT id, report_date AS reportDate FROM in_reports
    WHERE symbol = ? AND released_at IS NULL AND eps_actual IS NULL AND report_date IS NOT NULL
      AND abs(julianday(report_date) - julianday(?)) <= ?
    ORDER BY abs(julianday(report_date) - julianday(?)), report_date LIMIT 1`).get(symbol, day, windowDays, day) as { id: number; reportDate: string } | undefined;
  return r ?? null;
}

/**
 * The report came out on another day than the calendar said: move it. The old date is always kept in
 * rescheduled_from; timing goes back to unknown and the expected/live moves of the old date are dropped.
 */
export function moveReportDate(db: DatabaseSync, id: number, newDate: string): void {
  db.prepare(`UPDATE in_reports SET rescheduled_from = report_date, report_date = ?, timing = 'UNKNOWN', timing_source = NULL
      WHERE id = ? AND report_date IS NOT ?`).run(newDate, id, newDate);
  db.prepare('DELETE FROM in_expected_moves WHERE report_id = ?').run(id);
  db.prepare('DELETE FROM in_live_moves WHERE report_id = ?').run(id);
}

export function listInRange(db: DatabaseSync, f: { from: string; to: string; q: string | null }): InReport[] {
  const where = ['r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [f.from, f.to];
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.symbol LIKE ? OR r.name LIKE ?)');
    params.push(`${term.toUpperCase()}%`, `%${term}%`);
  }
  const rows = db.prepare(`${SELECT_IN} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.symbol`)
    .all(...params) as unknown as InReportRow[];
  return rows.map(toInReport);
}

export function getInReport(db: DatabaseSync, id: number): InReport | undefined {
  const r = db.prepare(`${SELECT_IN} WHERE r.id = ?`).get(id) as unknown as InReportRow | undefined;
  return r && toInReport(r);
}

/** A straddle snapshot. A final one (taken at the last close before release) is never replaced. */
export function saveInExpectedMove(db: DatabaseSync, reportId: number, em: Omit<InExpectedMove, 'snapshotAt'>, final: boolean, now: string): boolean {
  const prev = db.prepare('SELECT final FROM in_expected_moves WHERE report_id = ?').get(reportId) as { final: number } | undefined;
  if (prev?.final === 1) return false;
  db.prepare(`INSERT OR REPLACE INTO in_expected_moves
    (report_id, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, final, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    reportId, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, final ? 1 : 0, now,
  );
  return true;
}

export function saveInLiveMove(
  db: DatabaseSync, reportId: number, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now: string,
): boolean {
  const prev = db.prepare('SELECT move_pct AS p FROM in_live_moves WHERE report_id = ?').get(reportId) as { p: number } | undefined;
  db.prepare(`INSERT OR REPLACE INTO in_live_moves (report_id, move_pct, illiquid, quote_time, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(reportId, m.movePct, m.illiquid ? 1 : 0, m.quoteTime, now);
  return prev?.p !== m.movePct;
}

/** Records a check; a found move is stored, a miss never blanks an earlier value. */
export function setInPrevMove(
  db: DatabaseSync, id: number, move: { pct: number; date: string; basis: 'known' | 'assumed' } | null, now: string,
): void {
  if (move) {
    db.prepare('UPDATE in_reports SET prev_move_pct = ?, prev_move_date = ?, prev_move_basis = ?, prev_move_checked_at = ? WHERE id = ?')
      .run(move.pct, move.date, move.basis, now, id);
  } else {
    db.prepare('UPDATE in_reports SET prev_move_checked_at = ? WHERE id = ?').run(now, id);
  }
}

export function setInEstimates(
  db: DatabaseSync, id: number,
  e: { eps: number | null; epsAnalysts: number | null; revenue: number | null; revenueAnalysts: number | null }, now: string,
): void {
  db.prepare(`UPDATE in_reports SET eps_estimate = COALESCE(?, eps_estimate), eps_analysts = COALESCE(?, eps_analysts),
      revenue_estimate = COALESCE(?, revenue_estimate), revenue_analysts = COALESCE(?, revenue_analysts),
      estimates_fetched_at = ? WHERE id = ?`)
    .run(e.eps, e.epsAnalysts, e.revenue, e.revenueAnalysts, now, id);
}

export function getInPref(db: DatabaseSync, userId: string): 'US' | 'IN' {
  const row = db.prepare('SELECT market FROM user_prefs WHERE user_id = ?').get(userId) as { market: string } | undefined;
  return row?.market === 'IN' ? 'IN' : 'US';
}

export function setInPref(db: DatabaseSync, userId: string, market: 'US' | 'IN', now: string): void {
  db.prepare(`INSERT INTO user_prefs (user_id, market, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET market = excluded.market, updated_at = excluded.updated_at`)
    .run(userId, market, now);
}

export interface PendingReport { id: number; symbol: string; reportDate: string; timing: InTiming; quarterEnd: string }

/** Unreleased F&O reports in the range whose expected move is not final yet (all unreleased with `includeFinal`). */
export function inReportsForSnapshot(db: DatabaseSync, from: string, to: string, includeFinal = false): PendingReport[] {
  return db.prepare(`SELECT r.id, r.symbol, r.report_date AS reportDate, r.timing, r.quarter_end AS quarterEnd FROM in_reports r
    JOIN in_stocks s ON s.symbol = r.symbol AND s.active = 1
    LEFT JOIN in_expected_moves m ON m.report_id = r.id
    WHERE r.report_date BETWEEN ? AND ? AND r.released_at IS NULL AND r.eps_actual IS NULL AND (? OR COALESCE(m.final, 0) = 0)`)
    .all(from, to, includeFinal ? 1 : 0) as unknown as PendingReport[];
}

/** Active F&O reports in the range (for estimates). */
export function inReportsBetween(db: DatabaseSync, from: string, to: string): PendingReport[] {
  return db.prepare(`SELECT r.id, r.symbol, r.report_date AS reportDate, r.timing, r.quarter_end AS quarterEnd FROM in_reports r
    JOIN in_stocks s ON s.symbol = r.symbol AND s.active = 1 WHERE r.report_date BETWEEN ? AND ?`)
    .all(from, to) as unknown as PendingReport[];
}

/** Reports with no previous move yet, not checked since `recheckBefore`. */
export function inReportsNeedingPrevMove(db: DatabaseSync, from: string, to: string, recheckBefore: string): { id: number; symbol: string; reportDate: string }[] {
  return db.prepare(`SELECT r.id, r.symbol, r.report_date AS reportDate FROM in_reports r
    JOIN in_stocks s ON s.symbol = r.symbol AND s.active = 1
    WHERE r.report_date BETWEEN ? AND ? AND r.prev_move_pct IS NULL
      AND (r.prev_move_checked_at IS NULL OR r.prev_move_checked_at < ?)`)
    .all(from, to, recheckBefore) as unknown as { id: number; symbol: string; reportDate: string }[];
}

/** The latest earlier report of `symbol` whose results are out. */
export function priorReleasedReport(db: DatabaseSync, symbol: string, before: string): { reportDate: string; timing: InTiming; known: boolean } | null {
  const r = db.prepare(`SELECT report_date, timing, released_at FROM in_reports
    WHERE symbol = ? AND report_date < ? AND (released_at IS NOT NULL OR eps_actual IS NOT NULL)
    ORDER BY report_date DESC LIMIT 1`).get(symbol, before) as { report_date: string; timing: string; released_at: string | null } | undefined;
  return r ? { reportDate: r.report_date, timing: r.timing as InTiming, known: r.released_at != null && r.timing !== 'UNKNOWN' } : null;
}
