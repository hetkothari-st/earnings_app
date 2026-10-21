import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceStatusDto } from '../api/types.js';
import { DateTime } from 'luxon';
import { ET, sessionClose } from '../domain/marketCalendar.js';
import { normalizeTicker } from '../domain/ticker.js';
import { ensureInSchema } from '../india/db/inRepo.js';
import type {
  CalendarRow, ExpectedMove, InvestingRow, LiveMove, PrevMoveBasis, ReportRecord, RevenueRow, SecCheck, Timing, TimingSource,
} from '../types.js';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  symbol_key TEXT NOT NULL,
  name TEXT NOT NULL,
  fiscal_quarter TEXT NOT NULL,
  report_date TEXT NOT NULL,
  rescheduled_from TEXT,
  timing TEXT NOT NULL DEFAULT 'UNKNOWN',
  timing_source TEXT,
  timing_conflict TEXT,
  market_cap REAL,
  market_cap_as_of TEXT,
  eps_estimate REAL,
  eps_actual REAL,
  eps_surprise_pct REAL,
  eps_actual_source TEXT,
  eps_conflict TEXT,
  no_of_ests INTEGER,
  last_year_eps REAL,
  last_year_rpt_dt TEXT,
  revenue_estimate REAL,
  revenue_actual REAL,
  revenue_currency TEXT,
  exchange TEXT,
  sec_check TEXT,
  sec_accepted_at TEXT,
  sec_doc_url TEXT,
  released_at TEXT,
  release_source TEXT,
  sec_index_url TEXT,
  calendar_fetched_at TEXT,
  revenue_fetched_at TEXT,
  sec_checked_at TEXT,
  prev_move_pct REAL,
  prev_move_date TEXT,
  prev_move_checked_at TEXT,
  prev_move_basis TEXT,
  sector TEXT,
  industry TEXT,
  UNIQUE (symbol_key, fiscal_quarter)
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports (report_date);
CREATE INDEX IF NOT EXISTS idx_reports_key_date ON reports (symbol_key, report_date);
CREATE TABLE IF NOT EXISTS expected_moves (
  report_id INTEGER PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  call_mid REAL NOT NULL,
  put_mid REAL NOT NULL,
  underlying REAL NOT NULL,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  options_volume INTEGER,
  provisional INTEGER NOT NULL DEFAULT 0,
  quote_date TEXT,
  snapshot_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS live_moves (
  report_id INTEGER PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
  move_pct REAL NOT NULL,
  illiquid INTEGER NOT NULL,
  quote_time TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_status (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  state TEXT,
  blocked_until TEXT
);
CREATE TABLE IF NOT EXISTS backfill_progress (
  key TEXT PRIMARY KEY,
  done_at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout: the app and the backfill CLI share this file; wait for locks instead of failing.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  db.exec(SCHEMA);
  addMissingColumns(db);
  ensureInSchema(db);
  return db;
}

/** CREATE TABLE IF NOT EXISTS never alters an existing table; add any column the schema gained since. */
function addMissingColumns(db: Db): void {
  const reference = new DatabaseSync(':memory:');
  reference.exec(SCHEMA);
  type Col = { name: string; type: string };
  const cols = (d: Db, table: string) => d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Col[];
  for (const { name: table } of reference.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as unknown as { name: string }[]) {
    const have = new Set(cols(db, table).map((c) => c.name));
    for (const c of cols(reference, table)) {
      if (!have.has(c.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.name} ${c.type}`);
    }
  }
  reference.close();
}

export function inTransaction(db: Db, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface ReportRow {
  id: number; symbol: string; symbol_key: string; name: string; fiscal_quarter: string; report_date: string;
  rescheduled_from: string | null; timing: Timing; timing_source: TimingSource; timing_conflict: string | null;
  market_cap: number | null; market_cap_as_of: string | null; eps_estimate: number | null; eps_actual: number | null;
  eps_surprise_pct: number | null; eps_actual_source: string | null; eps_conflict: string | null; no_of_ests: number | null; last_year_eps: number | null; last_year_rpt_dt: string | null; revenue_estimate: number | null; revenue_actual: number | null; revenue_currency: string | null;
  exchange: string | null; sec_check: SecCheck | null; sec_accepted_at: string | null; sec_doc_url: string | null;
  sec_index_url: string | null; released_at: string | null; release_source: string | null; calendar_fetched_at: string | null; revenue_fetched_at: string | null; sec_checked_at: string | null;
  prev_move_pct: number | null; prev_move_date: string | null; prev_move_basis: PrevMoveBasis | null; sector: string | null; industry: string | null;
}

interface JoinedRow extends ReportRow {
  em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_options_volume: number | null; em_provisional: number | null; em_quote_date: string | null; lm_move_pct: number | null; lm_illiquid: number | null;
  lm_quote_time: string | null; lm_fetched_at: string | null; em_snapshot_at: string | null;
}

const SELECT_REPORT = `
SELECT r.*, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
       m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.options_volume AS em_options_volume, m.provisional AS em_provisional, m.quote_date AS em_quote_date, m.snapshot_at AS em_snapshot_at
, l.move_pct AS lm_move_pct, l.illiquid AS lm_illiquid, l.quote_time AS lm_quote_time, l.fetched_at AS lm_fetched_at
FROM reports r LEFT JOIN expected_moves m ON m.report_id = r.id LEFT JOIN live_moves l ON l.report_id = r.id`;

function toRecord(r: JoinedRow): ReportRecord {
  return {
    id: r.id, symbol: r.symbol, symbolKey: r.symbol_key, name: r.name, fiscalQuarter: r.fiscal_quarter,
    reportDate: r.report_date, rescheduledFrom: r.rescheduled_from, timing: r.timing, timingSource: r.timing_source,
    timingConflict: r.timing_conflict, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of,
    epsEstimate: r.eps_estimate, epsActual: r.eps_actual, epsSurprisePct: r.eps_surprise_pct, epsConflict: r.eps_conflict, noOfEsts: r.no_of_ests,
    lastYearEps: r.last_year_eps, lastYearReportDate: r.last_year_rpt_dt,
    revenueEstimate: r.revenue_estimate, revenueActual: r.revenue_actual, revenueCurrency: r.revenue_currency, exchange: r.exchange,
    secCheck: r.sec_check, secAcceptedAt: r.sec_accepted_at, secDocUrl: r.sec_doc_url, secIndexUrl: r.sec_index_url,
    releasedAt: r.released_at,
    calendarFetchedAt: r.calendar_fetched_at, revenueFetchedAt: r.revenue_fetched_at, secCheckedAt: r.sec_checked_at,
    expectedMove: r.em_snapshot_at == null ? null : {
      expiry: r.em_expiry!, strike: r.em_strike!, callMid: r.em_call_mid!, putMid: r.em_put_mid!,
      underlying: r.em_underlying!, movePct: r.em_move_pct!, illiquid: r.em_illiquid === 1, optionsVolume: r.em_options_volume, provisional: r.em_provisional === 1, quoteDate: r.em_quote_date,
      snapshotAt: r.em_snapshot_at,
    },
    prevMovePct: r.prev_move_pct, prevMoveDate: r.prev_move_date, prevMoveBasis: r.prev_move_basis, sector: r.sector, industry: r.industry,
    liveMove: r.lm_fetched_at == null ? null : {
      movePct: r.lm_move_pct!, illiquid: r.lm_illiquid === 1, quoteTime: r.lm_quote_time, fetchedAt: r.lm_fetched_at,
    },
  };
}

export function upsertCalendarRow(db: Db, row: CalendarRow, now: string, today: string): void {
  const key = normalizeTicker(row.symbol);
  const existing = (db.prepare('SELECT * FROM reports WHERE symbol_key = ? AND fiscal_quarter = ?')
    .get(key, row.fiscalQuarter)
    // Nasdaq sometimes omits the fiscal quarter ("date:" key). Same symbol on the same date is the same report.
    ?? db.prepare(`SELECT * FROM reports WHERE symbol_key = ? AND report_date = ?
        AND (fiscal_quarter LIKE 'date:%' OR ? LIKE 'date:%') ORDER BY fiscal_quarter LIKE 'date:%' LIMIT 1`)
      .get(key, row.reportDate, row.fiscalQuarter)) as unknown as ReportRow | undefined;

  if (!existing) {
    db.prepare(`INSERT INTO reports (symbol, symbol_key, name, fiscal_quarter, report_date, timing, timing_source,
      market_cap, market_cap_as_of, eps_estimate, eps_actual, eps_surprise_pct, eps_actual_source, no_of_ests, last_year_eps,
      last_year_rpt_dt, calendar_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.symbol, key, row.name, row.fiscalQuarter, row.reportDate, row.timing,
      row.timing === 'UNKNOWN' ? null : 'nasdaq',
      row.marketCap, row.marketCap == null ? null : today,
      row.epsEstimate, row.epsActual, row.epsSurprisePct, row.epsActual == null ? null : 'nasdaq', row.noOfEsts,
      row.lastYearEps, row.lastYearReportDate, now);
    return;
  }

  // Once the SEC filing has flipped the report, the actual release date/timing beat the calendar's.
  const released = existing.released_at != null;
  const reportDate = released ? existing.report_date : row.reportDate;
  const rescheduled = existing.report_date !== reportDate;
  let timing: Timing = existing.timing;
  let timingSource: TimingSource = existing.timing_source;
  if (released) {
    // keep the released timing
  } else if (row.timing !== 'UNKNOWN') {
    timing = row.timing;
    timingSource = 'nasdaq';
  } else if (rescheduled) {
    timing = 'UNKNOWN';         // old timing belonged to the old date
    timingSource = null;
  }
  const capLive = reportDate >= today && row.marketCap != null;
  const fiscalQuarter = existing.fiscal_quarter.startsWith('date:') ? row.fiscalQuarter : existing.fiscal_quarter;
  // A confirmed Nasdaq actual wins: it is on the same basis as Nasdaq's consensus estimate.
  // (The parser already drops Nasdaq's placeholder EPS shown before results are recorded.)
  let epsActual = existing.eps_actual;
  let epsSource = existing.eps_actual_source;
  let epsConflict = existing.eps_conflict;
  if (row.epsActual != null) {
    if ((existing.eps_actual_source === 'finnhub' || existing.eps_actual_source === 'yahoo' || existing.eps_actual_source === 'investing') && existing.eps_actual != null) {
      epsConflict = epsDisagreement(row.epsActual, existing.eps_actual, sourceName(existing.eps_actual_source));
    }
    epsActual = row.epsActual;
    epsSource = 'nasdaq';
  }

  db.prepare(`UPDATE reports SET name = ?, fiscal_quarter = ?, report_date = ?, rescheduled_from = ?, timing = ?, timing_source = ?,
      timing_conflict = CASE WHEN ? THEN NULL ELSE timing_conflict END,
      market_cap = ?, market_cap_as_of = ?,
      eps_estimate = COALESCE(?, eps_estimate),
      eps_actual = ?, eps_actual_source = ?, eps_conflict = ?,
      eps_surprise_pct = COALESCE(?, eps_surprise_pct), no_of_ests = COALESCE(?, no_of_ests),
      last_year_eps = COALESCE(?, last_year_eps), last_year_rpt_dt = COALESCE(?, last_year_rpt_dt),
      sec_check = CASE WHEN ? THEN NULL ELSE sec_check END,
      sec_accepted_at = CASE WHEN ? THEN NULL ELSE sec_accepted_at END,
      sec_doc_url = CASE WHEN ? THEN NULL ELSE sec_doc_url END,
      sec_index_url = CASE WHEN ? THEN NULL ELSE sec_index_url END,
      sec_checked_at = CASE WHEN ? THEN NULL ELSE sec_checked_at END,
      calendar_fetched_at = ?
    WHERE id = ?`).run(
    row.name, fiscalQuarter, reportDate, rescheduled ? existing.report_date : existing.rescheduled_from, timing, timingSource,
    // The conflict text names the old timing; the next Finnhub merge recomputes it.
    rescheduled || timing !== existing.timing ? 1 : 0,
    capLive ? row.marketCap : existing.market_cap, capLive ? today : existing.market_cap_as_of,
    row.epsEstimate, epsActual, epsSource, epsConflict, row.epsSurprisePct, row.noOfEsts, row.lastYearEps, row.lastYearReportDate,
    rescheduled ? 1 : 0, rescheduled ? 1 : 0, rescheduled ? 1 : 0, rescheduled ? 1 : 0, rescheduled ? 1 : 0,
    now, existing.id);

  // A snapshot's expiry was chosen for the old date/timing; it may no longer capture the release.
  if (rescheduled || timing !== existing.timing) dropExpectedMove(db, existing.id);
}

function epsDisagreement(nasdaq: number, other: number, otherName = 'Finnhub'): string | null {
  return Math.abs(nasdaq - other) > 0.005
    ? `Nasdaq reports EPS ${nasdaq}, ${otherName} ${other} (often adjusted vs GAAP)`
    : null;
}

function dropExpectedMove(db: Db, reportId: number): void {
  db.prepare('DELETE FROM expected_moves WHERE report_id = ?').run(reportId);
}

export function mergeFinnhubRow(db: Db, r: RevenueRow, now: string): boolean {
  const existing = db.prepare('SELECT * FROM reports WHERE symbol_key = ? AND report_date = ?')
    .get(normalizeTicker(r.symbol), r.reportDate) as unknown as ReportRow | undefined;
  if (!existing) return false;

  let timing = existing.timing;
  let source = existing.timing_source;
  let conflict = existing.timing_conflict;
  if (r.timing !== 'UNKNOWN' && existing.released_at == null) {
    if (source === 'nasdaq' || source === 'sec') {
      const label = source === 'nasdaq' ? 'Nasdaq' : 'SEC filing';
      conflict = r.timing === timing ? null : `${label} says ${timing}, Finnhub says ${r.timing}`;
    } else {
      timing = r.timing;
      source = 'finnhub';
      conflict = null;
    }
  }

  let epsActual = existing.eps_actual;
  let epsSource = existing.eps_actual_source;
  let epsConflict = existing.eps_conflict;
  if (r.epsActual != null) {
    if (existing.eps_actual_source === 'nasdaq' && existing.eps_actual != null) {
      epsConflict = epsDisagreement(existing.eps_actual, r.epsActual);
    } else {
      epsActual = r.epsActual;
      epsSource = 'finnhub';
    }
  }

  // Finnhub revenue is USD; never mix it into a row already held in another currency.
  const usdRow = existing.revenue_currency == null || existing.revenue_currency === 'USD';
  db.prepare(`UPDATE reports SET revenue_estimate = COALESCE(?, revenue_estimate),
      revenue_actual = COALESCE(?, revenue_actual), timing = ?, timing_source = ?, timing_conflict = ?,
      eps_actual = ?, eps_actual_source = ?, eps_conflict = ?, revenue_fetched_at = ? WHERE id = ?`)
    .run(usdRow ? r.revenueEstimate : null, usdRow ? r.revenueActual : null, timing, source, conflict, epsActual, epsSource, epsConflict, now, existing.id);
  if (timing !== existing.timing) dropExpectedMove(db, existing.id);
  return true;
}

/**
 * Investing.com fills gaps only: an EPS or revenue actual is written when none is stored yet, and a
 * different value from another source is flagged as a conflict instead of replacing it. Estimates,
 * surprise % and timing are not taken (their basis may differ from the stored consensus).
 */
export function mergeInvestingRow(db: Db, r: InvestingRow, now: string): boolean {
  const existing = db.prepare('SELECT * FROM reports WHERE symbol_key = ? AND report_date = ?')
    .get(normalizeTicker(r.symbol), r.reportDate) as unknown as ReportRow | undefined;
  if (!existing) return false;

  let epsActual = existing.eps_actual;
  let epsSource = existing.eps_actual_source;
  let epsConflict = existing.eps_conflict;
  if (r.epsActual != null) {
    if (existing.eps_actual == null) {
      epsActual = r.epsActual;
      epsSource = 'investing';
    } else if (existing.eps_actual_source !== 'investing' && epsConflict == null) {
      epsConflict = sourceDisagreement(sourceName(existing.eps_actual_source), existing.eps_actual, 'Investing.com', r.epsActual);
    }
  }
  // Investing.com revenue is in USD; never mix it into a row held in another currency.
  const usdRow = existing.revenue_currency == null || existing.revenue_currency === 'USD';
  const revenueActual = existing.revenue_actual ?? (usdRow ? r.revenueActual : null);

  if (epsActual === existing.eps_actual && epsConflict === existing.eps_conflict && revenueActual === existing.revenue_actual) return false;
  db.prepare(`UPDATE reports SET eps_actual = ?, eps_actual_source = ?, eps_conflict = ?, revenue_actual = ?,
      revenue_fetched_at = ? WHERE id = ?`)
    .run(epsActual, epsSource, epsConflict, revenueActual, now, existing.id);
  return true;
}

function sourceName(source: string | null): string {
  return source === 'nasdaq' ? 'Nasdaq' : source === 'yahoo' ? 'Yahoo' : source === 'investing' ? 'Investing.com' : 'Finnhub';
}

function sourceDisagreement(aName: string, a: number, bName: string, b: number): string | null {
  return Math.abs(a - b) > 0.005 ? `${aName} reports EPS ${a}, ${bName} ${b} (often adjusted vs GAAP)` : null;
}

export function listRange(
  db: Db,
  f: { from: string; to: string; minCap: number | null; q: string | null },
): ReportRecord[] {
  const where = ['r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [f.from, f.to];
  if (f.minCap != null) {
    where.push('(r.market_cap >= ? OR r.market_cap IS NULL)');
    params.push(f.minCap);
  }
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.symbol_key LIKE ? OR r.name LIKE ?)');
    params.push(`${normalizeTicker(term)}%`, `%${term}%`);
  }
  const rows = db.prepare(`${SELECT_REPORT} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.market_cap DESC, r.symbol`)
    .all(...params) as unknown as JoinedRow[];
  return rows.map(toRecord);
}

export function getReport(db: Db, id: number): ReportRecord | undefined {
  const r = db.prepare(`${SELECT_REPORT} WHERE r.id = ?`).get(id) as unknown as JoinedRow | undefined;
  return r && toRecord(r);
}

export function distinctSymbolKeys(db: Db): string[] {
  return (db.prepare('SELECT DISTINCT symbol_key AS k FROM reports').all() as unknown as { k: string }[]).map((r) => r.k);
}

export function setExchange(db: Db, symbolKey: string, exchange: string | null): void {
  db.prepare('UPDATE reports SET exchange = ? WHERE symbol_key = ?').run(exchange, symbolKey);
}

export interface PendingSec {
  id: number;
  symbolKey: string;
  reportDate: string;
  timing: Timing;
  timingSource: TimingSource;
}

export function reportsNeedingSec(db: Db, today: string, recheckSince: string): PendingSec[] {
  return db.prepare(`SELECT id, symbol_key AS symbolKey, report_date AS reportDate, timing, timing_source AS timingSource
      FROM reports
      WHERE report_date <= ?
        AND (sec_check IS NULL OR (sec_check = 'unverifiable' AND report_date >= ?))
      ORDER BY symbol_key, report_date`)
    .all(today, recheckSince) as unknown as PendingSec[];
}

export function setSecResult(
  db: Db,
  id: number,
  r: { check: SecCheck; timing: Timing; timingSource: TimingSource; acceptedAt: string | null; docUrl: string | null; indexUrl: string | null },
  now: string,
): void {
  const before = db.prepare('SELECT timing FROM reports WHERE id = ?').get(id) as unknown as { timing: Timing } | undefined;
  if (before && before.timing !== r.timing) dropExpectedMove(db, id);
  db.prepare(`UPDATE reports SET sec_check = ?, timing = ?, timing_source = ?, sec_accepted_at = ?, sec_doc_url = ?,
      sec_index_url = ?, sec_checked_at = ? WHERE id = ?`)
    .run(r.check, r.timing, r.timingSource, r.acceptedAt, r.docUrl, r.indexUrl, now, id);
}

/** The nearest report within +-3 calendar days of `date` that is not yet released (same day preferred). */
export function reportForRelease(
  db: Db, symbolKey: string, date: string,
): { id: number; reportDate: string; releasedAt: string | null } | null {
  const lo = shiftDate(date, -3);
  const hi = shiftDate(date, 3);
  const rows = db.prepare(`SELECT id, report_date AS reportDate, released_at AS releasedAt FROM reports
      WHERE symbol_key = ? AND report_date BETWEEN ? AND ? AND released_at IS NULL`)
    .all(symbolKey, lo, hi) as unknown as { id: number; reportDate: string; releasedAt: string | null }[];
  const dist = (d: string) => Math.abs(Date.parse(`${d}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`));
  rows.sort((a, b) => dist(a.reportDate) - dist(b.reportDate) || a.reportDate.localeCompare(b.reportDate));
  return rows[0] ?? null;
}

/** True if a report for this key within +-3 days of `date` was already released. */
export function hasReleasedNear(db: Db, symbolKey: string, date: string): boolean {
  return db.prepare(`SELECT 1 FROM reports WHERE symbol_key = ? AND report_date BETWEEN ? AND ? AND released_at IS NOT NULL LIMIT 1`)
    .get(symbolKey, shiftDate(date, -3), shiftDate(date, 3)) !== undefined;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Mark a report as released. Earliest time wins; the date and timing follow the actual release. Returns true if anything changed. */
export function markReleased(db: Db, id: number, releasedAt: string, source: 'sec-8k'): boolean {
  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow | undefined;
  if (!existing) return false;
  if (existing.released_at && existing.released_at <= releasedAt) return false;

  const et = DateTime.fromISO(releasedAt, { zone: 'utc' }).setZone(ET);
  const etDate = et.toISODate()!;
  let close: '16:00' | '13:00' = '16:00';
  try { close = sessionClose(etDate); } catch { /* calendar missing for this year: assume a full session */ }
  const minutes = et.hour * 60 + et.minute;
  const closeMin = Number(close.slice(0, 2)) * 60;
  const timing: Timing = minutes < 9 * 60 + 30 ? 'BMO' : minutes >= closeMin ? 'AMC' : 'DMH';

  const moved = existing.report_date !== etDate;
  db.prepare(`UPDATE reports SET released_at = ?, release_source = ?, report_date = ?, rescheduled_from = ?,
      timing = ?, timing_source = 'sec' WHERE id = ?`)
    .run(releasedAt, source, etDate, moved ? existing.report_date : existing.rescheduled_from, timing, id);
  if (moved || timing !== existing.timing) dropExpectedMove(db, id);
  return true;
}

/** Reports dated in [from, to] that have no final expected-move snapshot yet. */
export function reportsForSnapshot(
  db: Db, from: string, to: string,
): { id: number; symbol: string; reportDate: string; timing: Timing; quoteDate: string | null }[] {
  return db.prepare(`SELECT r.id, r.symbol, r.report_date AS reportDate, r.timing, m.quote_date AS quoteDate
      FROM reports r LEFT JOIN expected_moves m ON m.report_id = r.id
      WHERE r.report_date BETWEEN ? AND ? AND (m.report_id IS NULL OR m.provisional = 1)
      ORDER BY r.report_date, r.market_cap DESC`)
    .all(from, to) as unknown as { id: number; symbol: string; reportDate: string; timing: Timing; quoteDate: string | null }[];
}

export function saveExpectedMove(db: Db, reportId: number, em: ExpectedMove, snapshotAt: string): void {
  db.prepare(`INSERT OR REPLACE INTO expected_moves
      (report_id, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, options_volume, provisional, quote_date, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reportId, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0,
      em.optionsVolume ?? null, em.provisional ? 1 : 0, em.quoteDate ?? null, snapshotAt);
}

export function recordSourceSuccess(db: Db, source: string, now: string): void {
  db.prepare(`INSERT INTO source_status (source, last_success_at) VALUES (?, ?)
      ON CONFLICT (source) DO UPDATE SET last_success_at = excluded.last_success_at`).run(source, now);
}

export function recordSourceError(db: Db, source: string, message: string, now: string): void {
  db.prepare(`INSERT INTO source_status (source, last_error, last_error_at) VALUES (?, ?, ?)
      ON CONFLICT (source) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`)
    .run(source, message.slice(0, 500), now);
}

export function listSourceStatus(db: Db): SourceStatusDto[] {
  return db.prepare(`SELECT source, last_success_at AS lastSuccessAt, last_error AS lastError, last_error_at AS lastErrorAt,
      state, blocked_until AS blockedUntil
      FROM source_status ORDER BY source`).all() as unknown as SourceStatusDto[];
}

export function isBackfilled(db: Db, key: string): boolean {
  return db.prepare('SELECT 1 FROM backfill_progress WHERE key = ?').get(key) !== undefined;
}

export function markBackfilled(db: Db, key: string, now: string): void {
  db.prepare('INSERT OR REPLACE INTO backfill_progress (key, done_at) VALUES (?, ?)').run(key, now);
}

export function counts(db: Db): { reports: number; withExpectedMove: number; secVerified: number } {
  const one = (sql: string) => (db.prepare(sql).get() as unknown as { n: number }).n;
  return {
    reports: one('SELECT COUNT(*) AS n FROM reports'),
    withExpectedMove: one('SELECT COUNT(*) AS n FROM expected_moves'),
    secVerified: one(`SELECT COUNT(*) AS n FROM reports WHERE sec_check IN ('verified', 'consistent', 'derived')`),
  };
}

/** The symbol's most recent report before `before`. */
export function previousReport(
  db: Db, symbolKey: string, before: string,
): { reportDate: string; timing: Timing; secAcceptedAt: string | null } | undefined {
  return db.prepare(`SELECT report_date AS reportDate, timing, sec_accepted_at AS secAcceptedAt FROM reports
      WHERE symbol_key = ? AND report_date < ? ORDER BY report_date DESC LIMIT 1`)
    .get(symbolKey, before) as unknown as { reportDate: string; timing: Timing; secAcceptedAt: string | null } | undefined;
}

/** Reports in [from, to] with no previous move yet, not re-checked since `recheckBefore`. */
export function reportsNeedingPrevMove(
  db: Db, from: string, to: string, recheckBefore: string,
): { id: number; symbol: string; symbolKey: string; reportDate: string; timing: Timing }[] {
  return db.prepare(`SELECT id, symbol, symbol_key AS symbolKey, report_date AS reportDate, timing FROM reports
      WHERE report_date BETWEEN ? AND ? AND prev_move_pct IS NULL
        AND (prev_move_checked_at IS NULL OR prev_move_checked_at < ?)
      ORDER BY report_date, market_cap DESC`)
    .all(from, to, recheckBefore) as unknown as { id: number; symbol: string; symbolKey: string; reportDate: string; timing: Timing }[];
}

export function setPrevMove(
  db: Db, id: number, pct: number | null, prevDate: string | null, basis: PrevMoveBasis | null, now: string,
): void {
  db.prepare('UPDATE reports SET prev_move_pct = ?, prev_move_date = ?, prev_move_basis = ?, prev_move_checked_at = ? WHERE id = ?')
    .run(pct, prevDate, basis, now, id);
}

export function setSectors(db: Db, sectors: Map<string, { sector: string | null; industry: string | null }>): void {
  const update = db.prepare('UPDATE reports SET sector = ?, industry = ? WHERE symbol_key = ?');
  for (const key of distinctSymbolKeys(db)) {
    const s = sectors.get(key);
    if (s) update.run(s.sector, s.industry, key);
  }
}

/** EPS and revenue actuals per report dated in [from, to], as comparable strings. */
export function actualsByReport(db: Db, from: string, to: string): Map<number, string> {
  const rows = db.prepare(`SELECT id, eps_actual AS e, revenue_actual AS r FROM reports WHERE report_date BETWEEN ? AND ?`)
    .all(from, to) as unknown as { id: number; e: number | null; r: number | null }[];
  return new Map(rows.map((x) => [x.id, `${x.e}|${x.r}`]));
}

/** Reports dated in [from, to]; the caller decides which are still before their release. */
export function reportsInRange(db: Db, from: string, to: string): { id: number; symbol: string; reportDate: string; timing: Timing }[] {
  return db.prepare(`SELECT id, symbol, report_date AS reportDate, timing FROM reports
      WHERE report_date BETWEEN ? AND ? ORDER BY report_date, market_cap DESC`)
    .all(from, to) as unknown as { id: number; symbol: string; reportDate: string; timing: Timing }[];
}

/** Saves the live move; returns true when the value differs from the stored one. */
export function saveLiveMove(db: Db, reportId: number, m: Omit<LiveMove, 'fetchedAt'>, now: string): boolean {
  const prev = db.prepare('SELECT move_pct AS p FROM live_moves WHERE report_id = ?').get(reportId) as unknown as { p: number } | undefined;
  db.prepare(`INSERT OR REPLACE INTO live_moves (report_id, move_pct, illiquid, quote_time, fetched_at) VALUES (?, ?, ?, ?, ?)`)
    .run(reportId, m.movePct, m.illiquid ? 1 : 0, m.quoteTime, now);
  return prev?.p !== m.movePct;
}

/** Reports in [from, to] still missing an EPS actual (if already reported), a revenue estimate or actual. */
export function reportsMissingValues(
  db: Db, from: string, to: string, today: string,
): { id: number; symbol: string; reportDate: string; fiscalQuarter: string }[] {
  return db.prepare(`SELECT id, symbol, report_date AS reportDate, fiscal_quarter AS fiscalQuarter FROM reports
      WHERE report_date BETWEEN ? AND ?
        AND (revenue_estimate IS NULL OR (report_date <= ? AND (eps_actual IS NULL OR revenue_actual IS NULL)))
      ORDER BY report_date, market_cap DESC`)
    .all(from, to, today) as unknown as { id: number; symbol: string; reportDate: string; fiscalQuarter: string }[];
}

/** Yahoo as a backup: fills only empty fields, never overwrites. */
export function mergeYahooFill(
  db: Db, id: number,
  f: { epsActual: number | null; revenueEstimate: number | null; revenueActual: number | null; revenueCurrency: string | null },
  now: string,
): void {
  const r = db.prepare('SELECT eps_actual, revenue_estimate, revenue_actual, revenue_currency FROM reports WHERE id = ?')
    .get(id) as unknown as { eps_actual: number | null; revenue_estimate: number | null; revenue_actual: number | null; revenue_currency: string | null } | undefined;
  if (!r) return;
  const takeEps = r.eps_actual == null && f.epsActual != null;
  // Revenue figures are only combined when they are in the same currency.
  const sameCurrency = (r.revenue_currency ?? (r.revenue_estimate != null || r.revenue_actual != null ? 'USD' : null)) ?? f.revenueCurrency;
  const revOk = f.revenueCurrency != null && sameCurrency === f.revenueCurrency;
  const takeEst = revOk && r.revenue_estimate == null && f.revenueEstimate != null;
  const takeAct = revOk && r.revenue_actual == null && f.revenueActual != null;
  if (!takeEps && !takeEst && !takeAct) return;
  db.prepare(`UPDATE reports SET
      eps_actual = CASE WHEN ? THEN ? ELSE eps_actual END,
      eps_actual_source = CASE WHEN ? THEN 'yahoo' ELSE eps_actual_source END,
      revenue_estimate = CASE WHEN ? THEN ? ELSE revenue_estimate END,
      revenue_actual = CASE WHEN ? THEN ? ELSE revenue_actual END,
      revenue_currency = CASE WHEN ? OR ? THEN ? ELSE revenue_currency END,
      revenue_fetched_at = ?
    WHERE id = ?`)
    .run(takeEps ? 1 : 0, f.epsActual, takeEps ? 1 : 0, takeEst ? 1 : 0, f.revenueEstimate, takeAct ? 1 : 0, f.revenueActual,
      takeEst ? 1 : 0, takeAct ? 1 : 0, f.revenueCurrency, now, id);
}

/** Symbols to stream live prices for: reporters dated in [from, to], nearest date then largest first. */
export function liveSymbols(db: Db, from: string, to: string, limit: number): string[] {
  return (db.prepare(`SELECT symbol FROM reports WHERE report_date BETWEEN ? AND ?
      GROUP BY symbol_key ORDER BY MIN(report_date), MAX(market_cap) DESC LIMIT ?`)
    .all(from, to, limit) as unknown as { symbol: string }[]).map((r) => r.symbol);
}
