import type { DatabaseSync } from 'node:sqlite';
import type { ExpectedMove } from '../../types.js';
import type { JpTiming } from '../domain/jpCalendar.js';
import type { JpPeriod } from '../domain/period.js';
import { jpLevel, type JpUniverseEntry, yahooJpSymbol } from '../universe.js';
import { JP_ADDED_COLUMNS, JP_SCHEMA } from './schema.js';

/** Japan report ids start here, so they never collide with US, India (1_000_000_001) or HK (2_000_000_001) ids. */
export const JP_ID_BASE = 3_000_000_001;

export function ensureJpSchema(db: DatabaseSync): void {
  db.exec(JP_SCHEMA);
  for (const [table, cols] of Object.entries(JP_ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export type JpActualSource = 'sec' | 'edinet' | 'yahoo';
export type JpSpan = 'quarter' | 'ytd';
export type JpYtdMonths = 6 | 9 | 12;
export type JpEstimateSpan = 'quarter' | 'year';

// ---------- Stocks ----------

export interface JpStock {
  code: string;
  edinetCode: string | null;
  /** Served name: the Yahoo profile name, else the universe name. */
  name: string;
  nameJa: string | null;
  yahooSymbol: string;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  cik: number | null;
  fyEndMonth: number | null;
  industryJa: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  active: boolean;
}

/**
 * Upserts the universe. Codes no longer listed become inactive and keep their reports. Universe fields (names,
 * EDINET code, fiscal year end, Japanese industry, level / ADR / CIK) always come from the entry; a Yahoo name
 * (`setJpProfile`) is kept apart and served in preference.
 */
export function syncJpUniverse(db: DatabaseSync, entries: readonly JpUniverseEntry[], now: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jp_stocks SET active = 0').run();
    const up = db.prepare(`INSERT INTO jp_stocks (code, edinet_code, name, name_ja, yahoo_symbol, level, adr, adr_ratio, cik, fy_end_month,
        industry_ja, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (code) DO UPDATE SET edinet_code = excluded.edinet_code, name = excluded.name, name_ja = excluded.name_ja,
        yahoo_symbol = excluded.yahoo_symbol, level = excluded.level, adr = excluded.adr, adr_ratio = excluded.adr_ratio, cik = excluded.cik,
        fy_end_month = excluded.fy_end_month, industry_ja = excluded.industry_ja, active = 1, updated_at = excluded.updated_at`);
    for (const e of entries) {
      up.run(e.code, e.edinetCode || null, e.name, e.nameJa || null, yahooJpSymbol(e.code), jpLevel(e), e.adr, e.adrRatio, e.cik,
        e.fyEndMonth, e.industryJa, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Name / sector / market cap (JPY) from Yahoo; a missing value never blanks a stored one. */
export function setJpProfile(
  db: DatabaseSync, code: string,
  p: { name: string | null; sector: string | null; industry: string | null; marketCap: number | null; asOf: string | null }, now: string,
): void {
  db.prepare(`UPDATE jp_stocks SET profile_name = COALESCE(?, profile_name), sector = COALESCE(?, sector), industry = COALESCE(?, industry),
      market_cap = COALESCE(?, market_cap), market_cap_as_of = COALESCE(?, market_cap_as_of),
      updated_at = ? WHERE code = ?`)
    .run(p.name?.trim() || null, p.sector, p.industry, p.marketCap, p.asOf, now, code);
}

interface StockRow {
  code: string; edinet_code: string | null; name: string; name_ja: string | null; profile_name: string | null; yahoo_symbol: string;
  level: string; adr: string | null; adr_ratio: number | null; cik: number | null; fy_end_month: number | null; industry_ja: string | null;
  sector: string | null; industry: string | null; market_cap: number | null; market_cap_as_of: string | null; active: number;
}

export function jpStocks(db: DatabaseSync): JpStock[] {
  return (db.prepare('SELECT * FROM jp_stocks ORDER BY code').all() as unknown as StockRow[]).map((r) => ({
    code: r.code, edinetCode: r.edinet_code, name: r.profile_name ?? r.name, nameJa: r.name_ja, yahooSymbol: r.yahoo_symbol,
    level: r.level === 'full' ? 'full' : 'basic', adr: r.adr, adrRatio: r.adr_ratio, cik: r.cik, fyEndMonth: r.fy_end_month,
    industryJa: r.industry_ja, sector: r.sector, industry: r.industry, marketCap: r.market_cap, marketCapAsOf: r.market_cap_as_of,
    active: r.active === 1,
  }));
}

// ---------- Reports ----------

export interface JpReport {
  id: number;
  code: string;
  name: string;
  nameJa: string | null;
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
  periodLabel: string;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  timing: JpTiming;
  timingSource: string | null;
  releasedAt: string | null;
  rescheduledFrom: string | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
  revenueSource: JpActualSource | null;
  revenueSpan: JpSpan | null;
  revenueYtdMonths: JpYtdMonths | null;
  /** Basic EPS per share. */
  epsActual: number | null;
  epsDilutedActual: number | null;
  epsCurrency: string | null;
  epsSource: JpActualSource | null;
  epsSpan: JpSpan | null;
  epsYtdMonths: JpYtdMonths | null;
  secDocUrl: string | null;
  edinetDocId: string | null;
  epsEstimate: number | null;
  epsAnalysts: number | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  estimateCurrency: string | null;
  estimateSpan: JpEstimateSpan | null;
  estimatesFetchedAt: string | null;
  prevMovePct: number | null;
  prevMoveDate: string | null;
  prevMoveBasis: 'known' | 'assumed' | null;
  prevMoveCheckedAt: string | null;
  calendarFetchedAt: string | null;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  industryJa: string | null;
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
  id: number; code: string; name: string; period_end: string; fiscal_quarter: number; fy_end: string; period_label: string; report_date: string;
  date_status: string; timing: string; timing_source: string | null; released_at: string | null; rescheduled_from: string | null;
  revenue_actual: number | null; revenue_currency: string | null; revenue_source: string | null; revenue_span: string | null;
  revenue_ytd_months: number | null;
  eps_actual: number | null; eps_diluted_actual: number | null; eps_currency: string | null; eps_source: string | null;
  eps_span: string | null; eps_ytd_months: number | null;
  sec_doc_url: string | null; edinet_doc_id: string | null;
  eps_estimate: number | null; eps_analysts: number | null; revenue_estimate: number | null; revenue_analysts: number | null;
  estimate_currency: string | null; estimate_span: string | null; estimates_fetched_at: string | null;
  prev_move_pct: number | null; prev_move_date: string | null; prev_move_basis: string | null; prev_move_checked_at: string | null;
  calendar_fetched_at: string | null;
  s_name: string; s_name_ja: string | null; s_level: string; s_adr: string | null; s_adr_ratio: number | null; s_industry_ja: string | null;
  s_sector: string | null; s_industry: string | null; s_market_cap: number | null; s_market_cap_as_of: string | null;
  em_adr: string | null; em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_final: number | null;
  em_quote_date: string | null; em_snapshot_at: string | null;
  lm_move_pct: number | null; lm_illiquid: number | null; lm_quote_time: string | null;
}

const SELECT_COLUMNS = `
SELECT r.*,
  COALESCE(s.profile_name, s.name) AS s_name, s.name_ja AS s_name_ja, s.level AS s_level, s.adr AS s_adr, s.adr_ratio AS s_adr_ratio,
  s.industry_ja AS s_industry_ja, s.sector AS s_sector, s.industry AS s_industry,
  s.market_cap AS s_market_cap, s.market_cap_as_of AS s_market_cap_as_of,
  m.adr AS em_adr, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
  m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.final AS em_final,
  m.quote_date AS em_quote_date, m.snapshot_at AS em_snapshot_at,
  l.move_pct AS lm_move_pct, l.illiquid AS lm_illiquid, l.quote_time AS lm_quote_time
FROM jp_reports r
JOIN jp_stocks s ON s.code = r.code`;
const SELECT_JOINS = `
LEFT JOIN jp_expected_moves m ON m.report_id = r.id
LEFT JOIN jp_live_moves l ON l.report_id = r.id`;
/** The calendar shows only stocks in the current universe. */
const SELECT_ACTIVE = `${SELECT_COLUMNS} AND s.active = 1${SELECT_JOINS}`;
/** Any stock with reports (watchlists). */
const SELECT_ANY = `${SELECT_COLUMNS}${SELECT_JOINS}`;

const asSource = (s: string | null): JpActualSource | null => (s === 'sec' || s === 'edinet' || s === 'yahoo' ? s : null);
const asSpan = (s: string | null): JpSpan | null => (s === 'quarter' || s === 'ytd' ? s : null);
const asMonths = (n: number | null): JpYtdMonths | null => (n === 6 || n === 9 || n === 12 ? n : null);

function toJpReport(r: ReportRow): JpReport {
  return {
    id: r.id,
    code: r.code,
    name: r.s_name,
    nameJa: r.s_name_ja,
    periodEnd: r.period_end,
    fiscalQuarter: r.fiscal_quarter as 1 | 2 | 3 | 4,
    fyEnd: r.fy_end,
    periodLabel: r.period_label,
    reportDate: r.report_date,
    dateStatus: r.date_status === 'confirmed' ? 'confirmed' : 'estimated',
    timing: r.timing as JpTiming,
    timingSource: r.timing_source,
    releasedAt: r.released_at,
    rescheduledFrom: r.rescheduled_from,
    revenueActual: r.revenue_actual,
    revenueCurrency: r.revenue_currency,
    revenueSource: asSource(r.revenue_source),
    revenueSpan: asSpan(r.revenue_span),
    revenueYtdMonths: asMonths(r.revenue_ytd_months),
    epsActual: r.eps_actual,
    epsDilutedActual: r.eps_diluted_actual,
    epsCurrency: r.eps_currency,
    epsSource: asSource(r.eps_source),
    epsSpan: asSpan(r.eps_span),
    epsYtdMonths: asMonths(r.eps_ytd_months),
    secDocUrl: r.sec_doc_url,
    edinetDocId: r.edinet_doc_id,
    epsEstimate: r.eps_estimate,
    epsAnalysts: r.eps_analysts,
    revenueEstimate: r.revenue_estimate,
    revenueAnalysts: r.revenue_analysts,
    estimateCurrency: r.estimate_currency,
    estimateSpan: r.estimate_span === 'quarter' || r.estimate_span === 'year' ? r.estimate_span : null,
    estimatesFetchedAt: r.estimates_fetched_at,
    prevMovePct: r.prev_move_pct,
    prevMoveDate: r.prev_move_date,
    prevMoveBasis: r.prev_move_basis === 'known' || r.prev_move_basis === 'assumed' ? r.prev_move_basis : null,
    prevMoveCheckedAt: r.prev_move_checked_at,
    calendarFetchedAt: r.calendar_fetched_at,
    level: r.s_level === 'full' ? 'full' : 'basic',
    adr: r.s_adr,
    adrRatio: r.s_adr_ratio,
    industryJa: r.s_industry_ja,
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
  db.prepare('SELECT * FROM jp_reports WHERE code = ? AND period_end = ?').get(code, periodEnd) as unknown as ReportRow | undefined;

const properName = (name: string, code: string) => (name.trim() && name.trim() !== code ? name.trim() : null);

/** Results are out: SEC acceptance recorded, or an EPS figure stored. */
const RELEASED_SQL = '(released_at IS NOT NULL OR eps_actual IS NOT NULL)';

/**
 * A report date for a period. Confirmed dates (from a 6-K date notice) never give way to estimated ones.
 * Once results are out the date is fixed. A new confirmed date for an unreleased row is a reschedule:
 * the old date is kept in rescheduled_from and timing goes back to unknown. Returns the report id.
 */
export function upsertJpCalendarRow(
  db: DatabaseSync,
  row: {
    code: string; name: string; period: JpPeriod; periodLabel: string; reportDate: string;
    dateStatus: 'confirmed' | 'estimated'; timing?: JpTiming; timingSource?: string;
  },
  now: string,
): number {
  const timing = row.timing ?? 'UNKNOWN';
  const source = timing === 'UNKNOWN' ? null : row.timingSource ?? null;
  const existing = findReport(db, row.code, row.period.periodEnd);
  if (!existing) {
    const r = db.prepare(`INSERT INTO jp_reports (id, code, name, period_end, fiscal_quarter, fy_end, period_label, report_date, date_status,
        timing, timing_source, calendar_fetched_at)
      VALUES ((SELECT max(COALESCE(MAX(id), 0) + 1, ?) FROM jp_reports), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(JP_ID_BASE, row.code, row.name, row.period.periodEnd, row.period.fiscalQuarter, row.period.fyEnd, row.periodLabel,
        row.reportDate, row.dateStatus, timing, source, now) as { id: number };
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
    db.prepare('UPDATE jp_reports SET name = ?, date_status = ?, timing = ?, timing_source = ?, calendar_fetched_at = ? WHERE id = ?')
      .run(name, status, setTiming ? timing : existing.timing, setTiming ? source : existing.timing_source, now, existing.id);
    return existing.id;
  }
  db.prepare(`UPDATE jp_reports SET name = ?, report_date = ?, date_status = ?, timing = ?, timing_source = ?,
      rescheduled_from = CASE WHEN ? = 'confirmed' THEN ? ELSE rescheduled_from END, calendar_fetched_at = ? WHERE id = ?`)
    .run(name, row.reportDate, row.dateStatus, timing, source, existing.date_status, existing.report_date, now, existing.id);
  db.prepare('DELETE FROM jp_expected_moves WHERE report_id = ?').run(existing.id);
  db.prepare('DELETE FROM jp_live_moves WHERE report_id = ?').run(existing.id);
  return existing.id;
}

/**
 * The moment results were made public (SEC 6-K acceptance). The earliest one wins. `timing` (stated by the
 * release, never derived from acceptance; Ruling 7) is written only when non-null. Returns true if anything was written.
 */
export function recordJpRelease(db: DatabaseSync, id: number, releasedAt: string, timing: JpTiming | null): boolean {
  const r = db.prepare('SELECT released_at FROM jp_reports WHERE id = ?').get(id) as { released_at: string | null } | undefined;
  if (!r) return false;
  if (r.released_at && Date.parse(r.released_at) <= Date.parse(releasedAt)) return false;
  if (timing && timing !== 'UNKNOWN') {
    db.prepare(`UPDATE jp_reports SET released_at = ?, timing = ?, timing_source = 'sec-6k' WHERE id = ?`).run(releasedAt, timing, id);
  } else {
    db.prepare('UPDATE jp_reports SET released_at = ? WHERE id = ?').run(releasedAt, id);
  }
  return true;
}

/** The unreleased report of `code` (any period) dated nearest to `day`, within `windowDays` calendar days. */
export function nearestUnreleasedJp(
  db: DatabaseSync, code: string, day: string, windowDays = 3,
): { id: number; reportDate: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4 } | null {
  const r = db.prepare(`SELECT id, report_date AS reportDate, period_end AS periodEnd, fiscal_quarter AS fiscalQuarter FROM jp_reports
    WHERE code = ? AND NOT ${RELEASED_SQL} AND abs(julianday(report_date) - julianday(?)) <= ?
    ORDER BY abs(julianday(report_date) - julianday(?)), report_date LIMIT 1`).get(code, day, windowDays, day) as
    { id: number; reportDate: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4 } | undefined;
  return r ?? null;
}

export function findJpReportId(db: DatabaseSync, code: string, periodEnd: string): number | null {
  return findReport(db, code, periodEnd)?.id ?? null;
}

/**
 * The report came out on another day than the calendar said: the old date is kept, move snapshots reset. Timing
 * resets too, unless `keepTiming` (a timing stated by a filing notice is never reset).
 */
export function moveJpReportDate(db: DatabaseSync, id: number, newDate: string, opts: { keepTiming?: boolean } = {}): void {
  if (opts.keepTiming) {
    db.prepare('UPDATE jp_reports SET rescheduled_from = report_date, report_date = ? WHERE id = ? AND report_date IS NOT ?').run(newDate, id, newDate);
  } else {
    db.prepare(`UPDATE jp_reports SET rescheduled_from = report_date, report_date = ?, timing = 'UNKNOWN', timing_source = NULL
        WHERE id = ? AND report_date IS NOT ?`).run(newDate, id, newDate);
  }
  db.prepare('DELETE FROM jp_expected_moves WHERE report_id = ?').run(id);
  db.prepare('DELETE FROM jp_live_moves WHERE report_id = ?').run(id);
}

/** Writes timing only while it is unknown and the row is unreleased. */
export function setJpTiming(db: DatabaseSync, id: number, timing: JpTiming, source: 'yahoo'): boolean {
  if (timing === 'UNKNOWN') return false;
  const r = db.prepare(`UPDATE jp_reports SET timing = ?, timing_source = ?
    WHERE id = ? AND timing = 'UNKNOWN' AND NOT ${RELEASED_SQL}`).run(timing, source, id);
  return Number(r.changes) > 0;
}

const RANK: Record<JpActualSource, number> = { sec: 3, edinet: 2, yahoo: 1 };
const rankOf = (s: string | null): number => (s === 'sec' || s === 'edinet' || s === 'yahoo' ? RANK[s] : 0);
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Actuals, per field group (revenue; basic + diluted EPS), each with its own source, currency and span.
 * Precedence SEC > EDINET > Yahoo: a group is written when nothing is stored for it or the incoming source ranks
 * higher than the stored one. An equal or lower source is never written (the first of a source wins). A group
 * without a value never blanks a stored one. An EPS group with only a diluted figure is stored only when the row
 * has no EPS at all. When a group is written, all its columns come from the incoming source (one source per group).
 * `docUrl` / `edinetDocId` are written when none is stored, or with a group their source wrote.
 * Returns true if anything changed.
 */
export function mergeJpActuals(
  db: DatabaseSync, id: number,
  a: {
    revenue?: { value: number; currency: string; span: JpSpan; ytdMonths: JpYtdMonths | null } | null;
    eps?: { basic: number | null; diluted: number | null; currency: string; span: JpSpan; ytdMonths: JpYtdMonths | null } | null;
    source: JpActualSource; docUrl?: string | null; edinetDocId?: string | null;
  },
  _now: string,
): boolean {
  const r = db.prepare(`SELECT revenue_actual, revenue_source, eps_actual, eps_diluted_actual, eps_source, sec_doc_url, edinet_doc_id
    FROM jp_reports WHERE id = ?`).get(id) as
    { revenue_actual: number | null; revenue_source: string | null; eps_actual: number | null; eps_diluted_actual: number | null;
      eps_source: string | null; sec_doc_url: string | null; edinet_doc_id: string | null } | undefined;
  if (!r) return false;
  const rank = RANK[a.source];
  let changed = false;
  let wrote = false;

  const rev = a.revenue;
  if (rev && finite(rev.value) && (r.revenue_actual == null || rank > rankOf(r.revenue_source))) {
    db.prepare(`UPDATE jp_reports SET revenue_actual = ?, revenue_currency = ?, revenue_source = ?, revenue_span = ?, revenue_ytd_months = ?
        WHERE id = ?`).run(rev.value, rev.currency || null, a.source, rev.span, rev.span === 'ytd' ? rev.ytdMonths : null, id);
    changed = wrote = true;
  }

  const eps = a.eps;
  if (eps) {
    const basic = finite(eps.basic) ? eps.basic : null;
    const diluted = finite(eps.diluted) ? eps.diluted : null;
    const stored = r.eps_actual != null || r.eps_diluted_actual != null;
    const ok = basic != null ? !stored || rank > rankOf(r.eps_source) : diluted != null && !stored;
    if (ok) {
      db.prepare(`UPDATE jp_reports SET eps_actual = ?, eps_diluted_actual = ?, eps_currency = ?, eps_source = ?, eps_span = ?, eps_ytd_months = ?
          WHERE id = ?`).run(basic, diluted, eps.currency || null, a.source, eps.span, eps.span === 'ytd' ? eps.ytdMonths : null, id);
      changed = wrote = true;
    }
  }

  if (a.docUrl && a.docUrl !== r.sec_doc_url && (r.sec_doc_url == null || (wrote && a.source === 'sec'))) {
    db.prepare('UPDATE jp_reports SET sec_doc_url = ? WHERE id = ?').run(a.docUrl, id);
    changed = true;
  }
  if (a.edinetDocId && a.edinetDocId !== r.edinet_doc_id && (r.edinet_doc_id == null || (wrote && a.source === 'edinet'))) {
    db.prepare('UPDATE jp_reports SET edinet_doc_id = ? WHERE id = ?').run(a.edinetDocId, id);
    changed = true;
  }
  return changed;
}

/**
 * Consensus. A missing figure never blanks a stored one, except when the span (quarter / year) or the currency
 * changes: then all four values are written together (nulls for the missing ones), so a quarter figure never sits
 * beside a year figure and two currencies never sit in one row.
 */
export function setJpEstimates(
  db: DatabaseSync, id: number,
  e: {
    eps: number | null; epsAnalysts: number | null; revenue: number | null; revenueAnalysts: number | null; currency: string | null;
    span: JpEstimateSpan;
  },
  now: string,
): void {
  const stored = db.prepare('SELECT estimate_currency, estimate_span FROM jp_reports WHERE id = ?').get(id) as
    { estimate_currency: string | null; estimate_span: string | null } | undefined;
  if (!stored) return;
  const newSpan = stored.estimate_span != null && stored.estimate_span !== e.span;
  const newCurrency = e.currency != null && stored.estimate_currency != null && stored.estimate_currency !== e.currency;
  if (newSpan || newCurrency) {
    db.prepare(`UPDATE jp_reports SET eps_estimate = ?, eps_analysts = ?, revenue_estimate = ?, revenue_analysts = ?,
        estimate_currency = ?, estimate_span = ?, estimates_fetched_at = ? WHERE id = ?`)
      .run(e.eps, e.epsAnalysts, e.revenue, e.revenueAnalysts, e.currency, e.span, now, id);
    return;
  }
  db.prepare(`UPDATE jp_reports SET eps_estimate = COALESCE(?, eps_estimate), eps_analysts = COALESCE(?, eps_analysts),
      revenue_estimate = COALESCE(?, revenue_estimate), revenue_analysts = COALESCE(?, revenue_analysts),
      estimate_currency = COALESCE(?, estimate_currency), estimate_span = ?, estimates_fetched_at = ? WHERE id = ?`)
    .run(e.eps, e.epsAnalysts, e.revenue, e.revenueAnalysts, e.currency, e.span, now, id);
}

// ---------- Lists ----------

/** `q` matches the code, the English name (universe or Yahoo), the Japanese name or the ADR ticker. */
export function listJpRange(db: DatabaseSync, f: { from: string; to: string; q: string | null }): JpReport[] {
  const where = ['r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [f.from, f.to];
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.code LIKE ? OR r.name LIKE ? OR s.name LIKE ? OR COALESCE(s.profile_name, s.name) LIKE ? OR s.name_ja LIKE ? OR s.adr LIKE ?)');
    params.push(`${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `${term.toUpperCase()}%`);
  }
  const rows = db.prepare(`${SELECT_ACTIVE} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.code`)
    .all(...params) as unknown as ReportRow[];
  return rows.map(toJpReport);
}

/** Reports of the given codes dated in [from, to], in the universe or not (watchlists). */
export function listJpForSymbols(db: DatabaseSync, codes: string[], from: string, to: string): JpReport[] {
  if (codes.length === 0) return [];
  const rows = db.prepare(`${SELECT_ANY} WHERE r.code IN (${codes.map(() => '?').join(',')}) AND r.report_date BETWEEN ? AND ?
      ORDER BY r.report_date, r.code`).all(...codes, from, to) as unknown as ReportRow[];
  return rows.map(toJpReport);
}

export function getJpReport(db: DatabaseSync, id: number): JpReport | undefined {
  const r = db.prepare(`${SELECT_ANY} WHERE r.id = ?`).get(id) as unknown as ReportRow | undefined;
  return r && toJpReport(r);
}

// ---------- Moves ----------

/** An ADR straddle snapshot. A final one (taken at the last US close before release) is never replaced. */
export function saveJpExpectedMove(
  db: DatabaseSync, id: number, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now: string,
): boolean {
  const prev = db.prepare('SELECT final FROM jp_expected_moves WHERE report_id = ?').get(id) as { final: number } | undefined;
  if (prev?.final === 1) return false;
  db.prepare(`INSERT OR REPLACE INTO jp_expected_moves
    (report_id, adr, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, final, quote_date, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, em.adr, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, final ? 1 : 0, em.quoteDate, now,
  );
  return true;
}

export function saveJpLiveMove(
  db: DatabaseSync, id: number, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now: string,
): boolean {
  const prev = db.prepare('SELECT move_pct AS p FROM jp_live_moves WHERE report_id = ?').get(id) as { p: number } | undefined;
  db.prepare(`INSERT OR REPLACE INTO jp_live_moves (report_id, move_pct, illiquid, quote_time, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, m.movePct, m.illiquid ? 1 : 0, m.quoteTime, now);
  return prev?.p !== m.movePct;
}

/** The stored snapshot's quote date and finality, or null when none is stored. */
export function storedJpExpectedMove(db: DatabaseSync, id: number): { quoteDate: string; final: boolean } | null {
  const r = db.prepare('SELECT quote_date, final FROM jp_expected_moves WHERE report_id = ?').get(id) as
    { quote_date: string | null; final: number } | undefined;
  return r ? { quoteDate: r.quote_date ?? '', final: r.final === 1 } : null;
}

/** Records a check; a found move is stored, a miss never blanks an earlier value. */
export function setJpPrevMove(
  db: DatabaseSync, id: number, move: { pct: number; date: string; basis: 'known' | 'assumed' } | null, now: string,
): void {
  if (move) {
    db.prepare('UPDATE jp_reports SET prev_move_pct = ?, prev_move_date = ?, prev_move_basis = ?, prev_move_checked_at = ? WHERE id = ?')
      .run(move.pct, move.date, move.basis, now, id);
  } else {
    db.prepare('UPDATE jp_reports SET prev_move_checked_at = ? WHERE id = ?').run(now, id);
  }
}

// ---------- Job queries ----------

export interface JpPending {
  id: number;
  code: string;
  reportDate: string;
  timing: JpTiming;
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  releasedAt: string | null;
  level: 'full' | 'basic';
  adr: string | null;
  cik: number | null;
  /** Basic or diluted EPS stored. */
  hasEps: boolean;
  hasRevenue: boolean;
  expectedFinal: boolean;
}

/** Reports of universe stocks dated in the range. */
export function jpReportsBetween(db: DatabaseSync, from: string, to: string): JpPending[] {
  const rows = db.prepare(`SELECT r.id, r.code, r.report_date AS reportDate, r.timing, r.period_end AS periodEnd,
      r.fiscal_quarter AS fiscalQuarter, r.released_at AS releasedAt, s.level, s.adr, s.cik,
      (r.eps_actual IS NOT NULL OR r.eps_diluted_actual IS NOT NULL) AS hasEps,
      r.revenue_actual IS NOT NULL AS hasRevenue, COALESCE(m.final, 0) AS expectedFinal
    FROM jp_reports r JOIN jp_stocks s ON s.code = r.code AND s.active = 1
    LEFT JOIN jp_expected_moves m ON m.report_id = r.id
    WHERE r.report_date BETWEEN ? AND ? ORDER BY r.report_date, r.code`).all(from, to) as unknown as
    (Omit<JpPending, 'hasEps' | 'hasRevenue' | 'expectedFinal' | 'level'>
      & { level: string; hasEps: number; hasRevenue: number; expectedFinal: number })[];
  return rows.map((r) => ({
    ...r, level: r.level === 'full' ? 'full' : 'basic', hasEps: r.hasEps === 1, hasRevenue: r.hasRevenue === 1,
    expectedFinal: r.expectedFinal === 1,
  }));
}

/** Reports with no previous move yet, not checked since `recheckBefore`. */
export function jpReportsNeedingPrevMove(
  db: DatabaseSync, from: string, to: string, recheckBefore: string,
): { id: number; code: string; reportDate: string; timing: JpTiming }[] {
  return db.prepare(`SELECT r.id, r.code, r.report_date AS reportDate, r.timing FROM jp_reports r
    JOIN jp_stocks s ON s.code = r.code AND s.active = 1
    WHERE r.report_date BETWEEN ? AND ? AND r.prev_move_pct IS NULL
      AND (r.prev_move_checked_at IS NULL OR r.prev_move_checked_at < ?)`)
    .all(from, to, recheckBefore) as unknown as { id: number; code: string; reportDate: string; timing: JpTiming }[];
}

/** The latest earlier report of `code` whose results are out. */
export function priorJpReleased(db: DatabaseSync, code: string, before: string): { reportDate: string; timing: JpTiming; known: boolean } | null {
  const r = db.prepare(`SELECT report_date, timing, released_at FROM jp_reports
    WHERE code = ? AND report_date < ? AND ${RELEASED_SQL}
    ORDER BY report_date DESC LIMIT 1`).get(code, before) as { report_date: string; timing: string; released_at: string | null } | undefined;
  return r ? { reportDate: r.report_date, timing: r.timing as JpTiming, known: r.released_at != null && r.timing !== 'UNKNOWN' } : null;
}

/**
 * Past result dates from the Yahoo bulk sweep. Idempotent: a known timing fills an unknown one and a null never
 * blanks a stored timing. Returns the number of dates newly added.
 */
export function upsertJpPastDates(db: DatabaseSync, rows: { code: string; date: string; timing: JpTiming | null }[]): number {
  const before = jpPastDatesCount(db);
  const up = db.prepare(`INSERT INTO jp_past_dates (code, date, timing) VALUES (?, ?, ?)
    ON CONFLICT (code, date) DO UPDATE SET timing = COALESCE(excluded.timing, timing)`);
  db.exec('BEGIN');
  try {
    for (const r of rows) up.run(r.code, r.date, r.timing && r.timing !== 'UNKNOWN' ? r.timing : null);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return jpPastDatesCount(db) - before;
}

/** Past result dates of `code`, newest first. */
export function jpPastDates(db: DatabaseSync, code: string): { date: string; timing: JpTiming | null }[] {
  return db.prepare('SELECT date, timing FROM jp_past_dates WHERE code = ? ORDER BY date DESC').all(code) as unknown as
    { date: string; timing: JpTiming | null }[];
}

export function jpPastDatesCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM jp_past_dates').get() as { n: number }).n;
}

// ---------- SEC bookkeeping ----------

export function jpSecSeen(db: DatabaseSync, accession: string): boolean {
  return db.prepare('SELECT 1 FROM jp_sec_seen WHERE accession = ?').get(accession) != null;
}

export function markJpSecSeen(db: DatabaseSync, accession: string, cik: number | null, kind: 'results' | 'date-notice' | 'other', now: string): void {
  db.prepare('INSERT OR IGNORE INTO jp_sec_seen (accession, cik, kind, seen_at) VALUES (?, ?, ?, ?)').run(accession, cik, kind, now);
}

export function lastJpSecSeenAt(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(seen_at) AS t FROM jp_sec_seen').get() as { t: string | null }).t;
}

// ---------- EDINET bookkeeping ----------

/**
 * `merged`: actuals written. `superseded`: parsed and matched, but a higher or earlier source kept every field.
 * `no-row` / `blank` / `parse-error`: final, never retried. `error`: download failed, retried with backoff.
 */
export type EdinetOutcome = 'merged' | 'superseded' | 'no-row' | 'blank' | 'parse-error' | 'error';

/**
 * Wait before retrying an errored document: 15 min, doubling per attempt, at most 6 h. There is no attempt cap:
 * a document is only listed again while its date is inside the 7-day polling window, which bounds the retries.
 */
const edinetRetryDelayMs = (attempts: number): number => Math.min(15 * 60_000 * 2 ** (attempts - 1), 6 * 60 * 60_000);

/**
 * True when the document needs no (further) handling. Without `now`, any recorded outcome counts. With `now`, an
 * 'error' outcome counts only while its retry is not yet due.
 */
export function edinetSeen(db: DatabaseSync, docId: string, now?: string): boolean {
  const r = db.prepare('SELECT outcome, retry_after FROM jp_edinet_seen WHERE doc_id = ?').get(docId) as
    { outcome: string; retry_after: string | null } | undefined;
  if (!r) return false;
  if (now === undefined || r.outcome !== 'error') return true;
  return r.retry_after != null && Date.parse(r.retry_after) > Date.parse(now);
}

/**
 * Each EDINET document is handled once: the first final outcome (anything but 'error') is kept for good. An
 * 'error' outcome is provisional: a later error counts one more attempt and pushes the retry out (backoff), and a
 * later final outcome replaces it.
 */
export function markEdinetSeen(
  db: DatabaseSync, docId: string, code: string | null, docType: string, periodEnd: string | null, outcome: EdinetOutcome, now: string,
): void {
  const prev = db.prepare('SELECT outcome, attempts FROM jp_edinet_seen WHERE doc_id = ?').get(docId) as
    { outcome: string; attempts: number } | undefined;
  if (prev && prev.outcome !== 'error') return;
  const attempts = outcome === 'error' ? (prev?.attempts ?? 0) + 1 : prev?.attempts ?? 1;
  const retryAfter = outcome === 'error' ? new Date(Date.parse(now) + edinetRetryDelayMs(attempts)).toISOString() : null;
  db.prepare(`INSERT OR REPLACE INTO jp_edinet_seen (doc_id, code, doc_type, period_end, outcome, seen_at, attempts, retry_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(docId, code, docType, periodEnd, outcome, now, attempts, retryAfter);
}

export function lastEdinetSeenAt(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(seen_at) AS t FROM jp_edinet_seen').get() as { t: string | null }).t;
}
