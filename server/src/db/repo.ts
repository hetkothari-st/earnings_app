import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceStatusDto } from '../api/types.js';
import { normalizeTicker } from '../domain/ticker.js';
import type {
  CalendarRow, ExpectedMove, ReportRecord, RevenueRow, SecCheck, Timing, TimingSource,
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
  exchange TEXT,
  sec_check TEXT,
  sec_accepted_at TEXT,
  sec_doc_url TEXT,
  sec_index_url TEXT,
  calendar_fetched_at TEXT,
  revenue_fetched_at TEXT,
  sec_checked_at TEXT,
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
  snapshot_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_status (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
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
  return db;
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
  eps_surprise_pct: number | null; eps_actual_source: string | null; eps_conflict: string | null; no_of_ests: number | null; last_year_eps: number | null; last_year_rpt_dt: string | null; revenue_estimate: number | null; revenue_actual: number | null;
  exchange: string | null; sec_check: SecCheck | null; sec_accepted_at: string | null; sec_doc_url: string | null;
  sec_index_url: string | null; calendar_fetched_at: string | null; revenue_fetched_at: string | null; sec_checked_at: string | null;
}

interface JoinedRow extends ReportRow {
  em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_snapshot_at: string | null;
}

const SELECT_REPORT = `
SELECT r.*, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
       m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.snapshot_at AS em_snapshot_at
FROM reports r LEFT JOIN expected_moves m ON m.report_id = r.id`;

function toRecord(r: JoinedRow): ReportRecord {
  return {
    id: r.id, symbol: r.symbol, symbolKey: r.symbol_key, name: r.name, fiscalQuarter: r.fiscal_quarter,
    reportDate: r.report_date, rescheduledFrom: r.rescheduled_from, timing: r.timing, timingSource: r.timing_source,
    timingConflict: r.timing_conflict, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of,
    epsEstimate: r.eps_estimate, epsActual: r.eps_actual, epsSurprisePct: r.eps_surprise_pct, epsConflict: r.eps_conflict, noOfEsts: r.no_of_ests,
    lastYearEps: r.last_year_eps, lastYearReportDate: r.last_year_rpt_dt,
    revenueEstimate: r.revenue_estimate, revenueActual: r.revenue_actual, exchange: r.exchange,
    secCheck: r.sec_check, secAcceptedAt: r.sec_accepted_at, secDocUrl: r.sec_doc_url, secIndexUrl: r.sec_index_url,
    calendarFetchedAt: r.calendar_fetched_at, revenueFetchedAt: r.revenue_fetched_at, secCheckedAt: r.sec_checked_at,
    expectedMove: r.em_snapshot_at == null ? null : {
      expiry: r.em_expiry!, strike: r.em_strike!, callMid: r.em_call_mid!, putMid: r.em_put_mid!,
      underlying: r.em_underlying!, movePct: r.em_move_pct!, illiquid: r.em_illiquid === 1, snapshotAt: r.em_snapshot_at,
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

  const rescheduled = existing.report_date !== row.reportDate;
  let timing: Timing = existing.timing;
  let timingSource: TimingSource = existing.timing_source;
  if (row.timing !== 'UNKNOWN') {
    timing = row.timing;
    timingSource = 'nasdaq';
  } else if (rescheduled) {
    timing = 'UNKNOWN';         // old timing belonged to the old date
    timingSource = null;
  }
  const capLive = row.reportDate >= today && row.marketCap != null;
  const fiscalQuarter = existing.fiscal_quarter.startsWith('date:') ? row.fiscalQuarter : existing.fiscal_quarter;
  // A confirmed Nasdaq actual wins: it is on the same basis as Nasdaq's consensus estimate.
  // (The parser already drops Nasdaq's placeholder EPS shown before results are recorded.)
  let epsActual = existing.eps_actual;
  let epsSource = existing.eps_actual_source;
  let epsConflict = existing.eps_conflict;
  if (row.epsActual != null) {
    if (existing.eps_actual_source === 'finnhub' && existing.eps_actual != null) {
      epsConflict = epsDisagreement(row.epsActual, existing.eps_actual);
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
      calendar_fetched_at = ?
    WHERE id = ?`).run(
    row.name, fiscalQuarter, row.reportDate, rescheduled ? existing.report_date : existing.rescheduled_from, timing, timingSource,
    rescheduled ? 1 : 0,
    capLive ? row.marketCap : existing.market_cap, capLive ? today : existing.market_cap_as_of,
    row.epsEstimate, epsActual, epsSource, epsConflict, row.epsSurprisePct, row.noOfEsts, row.lastYearEps, row.lastYearReportDate,
    rescheduled ? 1 : 0, rescheduled ? 1 : 0,
    now, existing.id);

  // A snapshot's expiry was chosen for the old date/timing; it may no longer capture the release.
  if (rescheduled || timing !== existing.timing) dropExpectedMove(db, existing.id);
}

function epsDisagreement(nasdaq: number, finnhub: number): string | null {
  return Math.abs(nasdaq - finnhub) > 0.005
    ? `Nasdaq reports EPS ${nasdaq}, Finnhub ${finnhub} (often adjusted vs GAAP)`
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
  if (r.timing !== 'UNKNOWN') {
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

  db.prepare(`UPDATE reports SET revenue_estimate = COALESCE(?, revenue_estimate),
      revenue_actual = COALESCE(?, revenue_actual), timing = ?, timing_source = ?, timing_conflict = ?,
      eps_actual = ?, eps_actual_source = ?, eps_conflict = ?, revenue_fetched_at = ? WHERE id = ?`)
    .run(r.revenueEstimate, r.revenueActual, timing, source, conflict, epsActual, epsSource, epsConflict, now, existing.id);
  if (timing !== existing.timing) dropExpectedMove(db, existing.id);
  return true;
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

export function reportsForSnapshot(
  db: Db, today: string, nextDay: string,
): { id: number; symbol: string; reportDate: string; timing: Timing }[] {
  return db.prepare(`SELECT id, symbol, report_date AS reportDate, timing FROM reports
      WHERE (report_date = ? AND timing = 'AMC')
         OR (report_date = ? AND timing IN ('BMO', 'DMH', 'UNKNOWN'))`)
    .all(today, nextDay) as unknown as { id: number; symbol: string; reportDate: string; timing: Timing }[];
}

export function saveExpectedMove(db: Db, reportId: number, em: ExpectedMove, snapshotAt: string): void {
  db.prepare(`INSERT OR REPLACE INTO expected_moves
      (report_id, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reportId, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, snapshotAt);
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
  return db.prepare(`SELECT source, last_success_at AS lastSuccessAt, last_error AS lastError, last_error_at AS lastErrorAt
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
