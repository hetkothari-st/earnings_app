import type { DatabaseSync } from 'node:sqlite';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import type { ExpectedMove } from '../../types.js';
import type { EuropePeriod } from '../domain/period.js';
import type { EuropeMarket, ExchangeId } from '../exchanges.js';
import { httpUrlOrNull } from '../sources/sourceUrls.js';
import { europeLevel } from '../universe.js';
import type { EuropeUniverseEntry } from '../universeBuild.js';
import { EUROPE_ADDED_COLUMNS, EUROPE_SCHEMA } from './schema.js';

/** Report ids per market (Ruling 1): never colliding with US, India (1e9), HK (2e9), JP (3e9) or each other. */
export const UK_ID_BASE = 4_000_000_001;
export const EU_ID_BASE = 5_000_000_001;
const idBase = (market: EuropeMarket): number => (market === 'UK' ? UK_ID_BASE : EU_ID_BASE);

export function ensureEuropeSchema(db: DatabaseSync): void {
  db.exec(EUROPE_SCHEMA);
  for (const [table, cols] of Object.entries(EUROPE_ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export type EuropeActualSource = 'sec' | 'esef' | 'yahoo';
export type EuropeSpan = 'quarter' | 'ytd';
export type EuropeYtdMonths = 6 | 9 | 12;
export type EuropeEstimateSpan = 'quarter' | 'year';
export type EuropeTimingSource = 'sec-notice' | 'prn' | 'yahoo';
export type EuropeReleaseSource = 'sec' | 'prn' | 'dila' | 'yahoo';

const inTx = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

// ---------- Stocks ----------

export interface EuropeStock {
  symbol: string;
  market: EuropeMarket;
  exchange: ExchangeId;
  isin: string | null;
  lei: string | null;
  /** Served name: the curated name for full level; for basic, the Yahoo profile name, else the universe name. */
  name: string;
  mic: string | null;
  country: string | null;
  currency: string | null;
  fyEndMonth: number | null;
  fyEndSource: 'esef' | 'yahoo' | null;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  adrRatioVerified: boolean;
  cik: number | null;
  secForm: '6-K' | '8-K' | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapCurrency: string | null;
  marketCapAsOf: string | null;
  active: boolean;
  missedRefreshes: number;
}

/** The served-name SQL: full level keeps the curated universe.ts name; basic prefers Yahoo's. */
const SERVED_NAME = (s: string) => `CASE WHEN ${s}.level = 'full' THEN ${s}.name ELSE COALESCE(${s}.profile_name, ${s}.name) END`;

/**
 * Upserts one market's universe (Ruling 4). Universe fields always come from the entry; a Yahoo name, profile and
 * fiscal year end are kept apart. A symbol of the market missing from `entries` counts one missed refresh and turns
 * inactive at the second consecutive miss (never deleted; its reports stay). A symbol back in the universe is active
 * with its count reset. An empty `entries` is refused (throws): a failed build must never deactivate anything.
 * An ISIN that moved to a new symbol is released from the old row (isin NULL), which then misses like any other.
 */
export function syncEuropeUniverse(
  db: DatabaseSync, market: EuropeMarket, entries: readonly EuropeUniverseEntry[], now: string,
): { upserted: number; deactivated: number } {
  const mine = entries.filter((e) => e.market === market);
  if (mine.length === 0) throw new Error(`syncEuropeUniverse ${market}: empty universe refused`);
  return inTx(db, () => {
    const symbols = new Set(mine.map((e) => e.symbol));
    const release = db.prepare('UPDATE europe_stocks SET isin = NULL WHERE market = ? AND isin = ? AND symbol != ?');
    const up = db.prepare(`INSERT INTO europe_stocks (symbol, market, exchange, isin, lei, name, mic, country, currency, level, adr, adr_ratio,
        adr_ratio_verified, cik, sec_form, active, missed_refreshes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT (symbol) DO UPDATE SET market = excluded.market, exchange = excluded.exchange, isin = excluded.isin,
        lei = COALESCE(excluded.lei, lei), name = excluded.name, mic = excluded.mic, country = excluded.country, currency = excluded.currency,
        level = excluded.level, adr = excluded.adr, adr_ratio = excluded.adr_ratio, adr_ratio_verified = excluded.adr_ratio_verified,
        cik = excluded.cik, sec_form = excluded.sec_form, active = 1, missed_refreshes = 0, updated_at = excluded.updated_at`);
    for (const e of mine) {
      release.run(market, e.isin, e.symbol);
      up.run(e.symbol, market, e.exchange, e.isin, e.lei, e.name, e.mic, e.country, e.currency, europeLevel(e), e.adr, e.adrRatio,
        e.adrRatioVerified ? 1 : 0, e.cik, e.secForm, now);
    }
    const missing = (db.prepare('SELECT symbol, active, missed_refreshes FROM europe_stocks WHERE market = ?').all(market) as
      { symbol: string; active: number; missed_refreshes: number }[]).filter((s) => !symbols.has(s.symbol));
    const miss = db.prepare('UPDATE europe_stocks SET missed_refreshes = ?, active = ?, updated_at = ? WHERE symbol = ?');
    let deactivated = 0;
    for (const s of missing) {
      const n = s.missed_refreshes + 1;
      const active = s.active === 1 && n < 2 ? 1 : 0;
      if (s.active === 1 && active === 0) deactivated++;
      miss.run(n, active, now, s.symbol);
    }
    return { upserted: mine.length, deactivated };
  });
}

/**
 * Name / sector / industry / market cap (with the currency Yahoo states) and the fiscal year end. A missing value
 * never blanks a stored one. Fiscal year end (Ruling 6): `esef` replaces anything; `yahoo` never replaces `esef`.
 */
export function setEuropeProfile(
  db: DatabaseSync, symbol: string,
  p: {
    name: string | null; sector: string | null; industry: string | null; marketCap: number | null; marketCapCurrency: string | null;
    asOf: string | null; fyEndMonth?: { month: number; source: 'esef' | 'yahoo' };
  },
  now: string,
): void {
  // A cap is stored only with its currency, and a currency only with its cap: never a cap read in the wrong unit.
  // Its date moves with it: a new cap without a date gets no date, never the previous cap's.
  const capOk = p.marketCap != null && Number.isFinite(p.marketCap) && !!p.marketCapCurrency;
  db.prepare(`UPDATE europe_stocks SET profile_name = COALESCE(?, profile_name), sector = COALESCE(?, sector), industry = COALESCE(?, industry),
      market_cap = COALESCE(?, market_cap), market_cap_currency = COALESCE(?, market_cap_currency),
      market_cap_as_of = CASE WHEN ? THEN ? ELSE market_cap_as_of END, updated_at = ? WHERE symbol = ?`)
    .run(p.name?.trim() || null, p.sector?.trim() || null, p.industry?.trim() || null, capOk ? p.marketCap : null,
      capOk ? p.marketCapCurrency : null, capOk ? 1 : 0, capOk ? p.asOf : null, now, symbol);
  const fy = p.fyEndMonth;
  if (fy && Number.isInteger(fy.month) && fy.month >= 1 && fy.month <= 12) {
    db.prepare(`UPDATE europe_stocks SET fy_end_month = ?, fy_end_source = ?
      WHERE symbol = ? AND (? = 'esef' OR fy_end_source IS NULL OR fy_end_source != 'esef')`).run(fy.month, fy.source, symbol, fy.source);
  }
}

interface StockRow {
  symbol: string; market: string; exchange: string; isin: string | null; lei: string | null; name: string; profile_name: string | null;
  mic: string | null; country: string | null; currency: string | null; fy_end_month: number | null; fy_end_source: string | null;
  level: string; adr: string | null; adr_ratio: number | null; adr_ratio_verified: number; cik: number | null; sec_form: string | null;
  sector: string | null; industry: string | null; market_cap: number | null; market_cap_currency: string | null; market_cap_as_of: string | null;
  active: number; missed_refreshes: number;
}

function toEuropeStock(r: StockRow): EuropeStock {
  const level = r.level === 'full' ? 'full' : 'basic';
  return {
    symbol: r.symbol, market: r.market === 'UK' ? 'UK' : 'EU', exchange: r.exchange as ExchangeId, isin: r.isin, lei: r.lei,
    name: level === 'full' ? r.name : r.profile_name ?? r.name, mic: r.mic, country: r.country, currency: r.currency,
    fyEndMonth: r.fy_end_month, fyEndSource: r.fy_end_source === 'esef' || r.fy_end_source === 'yahoo' ? r.fy_end_source : null,
    level, adr: r.adr, adrRatio: r.adr_ratio, adrRatioVerified: r.adr_ratio_verified === 1, cik: r.cik,
    secForm: r.sec_form === '6-K' || r.sec_form === '8-K' ? r.sec_form : null,
    sector: r.sector, industry: r.industry, marketCap: r.market_cap, marketCapCurrency: r.market_cap_currency,
    marketCapAsOf: r.market_cap_as_of, active: r.active === 1, missedRefreshes: r.missed_refreshes,
  };
}

/** Every stock of the market, active or not. */
export function europeStocks(db: DatabaseSync, market: EuropeMarket): EuropeStock[] {
  return (db.prepare('SELECT * FROM europe_stocks WHERE market = ? ORDER BY symbol').all(market) as unknown as StockRow[]).map(toEuropeStock);
}

/** Active full-level stocks with a CIK (the 6-K watcher reads these every tick). */
export function europeFullLevelStocks(db: DatabaseSync, market: EuropeMarket): EuropeStock[] {
  return (db.prepare(`SELECT * FROM europe_stocks WHERE market = ? AND level = 'full' AND active = 1 AND cik IS NOT NULL ORDER BY symbol`)
    .all(market) as unknown as StockRow[]).map(toEuropeStock);
}

export function europeStockByIsin(db: DatabaseSync, market: EuropeMarket, isin: string): EuropeStock | null {
  const r = db.prepare('SELECT * FROM europe_stocks WHERE market = ? AND isin = ?').get(market, isin) as unknown as StockRow | undefined;
  return r ? toEuropeStock(r) : null;
}

/** Stocks of either market with this issuer LEI (one issuer can have several share lines). */
export function europeStocksByLei(db: DatabaseSync, lei: string): EuropeStock[] {
  return (db.prepare('SELECT * FROM europe_stocks WHERE lei = ? ORDER BY symbol').all(lei) as unknown as StockRow[]).map(toEuropeStock);
}

// ---------- Reports ----------

export interface EuropeReport {
  id: number;
  market: EuropeMarket;
  symbol: string;
  name: string;
  exchange: ExchangeId;
  isin: string | null;
  country: string | null;
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
  periodLabel: string;
  periodConfirmed: boolean;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  rescheduledFrom: string | null;
  timing: LocalTiming;
  timingSource: EuropeTimingSource | null;
  releasedAt: string | null;
  releasedSource: EuropeReleaseSource | null;
  signalTitle: string | null;
  signalUrl: string | null;
  revenueActual: number | null;
  revenueCurrency: string | null;
  revenueSource: EuropeActualSource | null;
  revenueSpan: EuropeSpan | null;
  revenueYtdMonths: EuropeYtdMonths | null;
  /** Basic EPS per share, in the unit the source states ('GBp' pence, 'GBP' pounds). */
  epsActual: number | null;
  epsDilutedActual: number | null;
  epsCurrency: string | null;
  epsSource: EuropeActualSource | null;
  epsSpan: EuropeSpan | null;
  epsYtdMonths: EuropeYtdMonths | null;
  secDocUrl: string | null;
  esefUrl: string | null;
  epsEstimate: number | null;
  epsAnalysts: number | null;
  epsEstimateCurrency: string | null;
  revenueEstimate: number | null;
  revenueAnalysts: number | null;
  revenueEstimateCurrency: string | null;
  estimateSpan: EuropeEstimateSpan | null;
  estimatesFetchedAt: string | null;
  prevMovePct: number | null;
  prevMoveDate: string | null;
  prevMoveBasis: 'known' | 'assumed' | null;
  prevMoveCheckedAt: string | null;
  calendarFetchedAt: string | null;
  level: 'full' | 'basic';
  adr: string | null;
  adrRatio: number | null;
  adrRatioVerified: boolean;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapCurrency: string | null;
  marketCapAsOf: string | null;
  expectedMove: (ExpectedMove & { adr: string; quoteDate: string; final: boolean; snapshotAt: string }) | null;
  liveMovePct: number | null;
  liveMoveIlliquid: boolean | null;
  liveMoveQuoteTime: string | null;
}

interface ReportRow {
  id: number; market: string; symbol: string; name: string; exchange: string; period_end: string; fiscal_quarter: number; fy_end: string;
  period_label: string; period_confirmed: number; report_date: string; date_status: string; rescheduled_from: string | null;
  timing: string; timing_source: string | null; released_at: string | null; released_source: string | null;
  signal_title: string | null; signal_url: string | null;
  revenue_actual: number | null; revenue_currency: string | null; revenue_source: string | null; revenue_span: string | null;
  revenue_ytd_months: number | null;
  eps_actual: number | null; eps_diluted_actual: number | null; eps_currency: string | null; eps_source: string | null;
  eps_span: string | null; eps_ytd_months: number | null;
  sec_doc_url: string | null; esef_url: string | null;
  eps_estimate: number | null; eps_analysts: number | null; eps_estimate_currency: string | null;
  revenue_estimate: number | null; revenue_analysts: number | null; revenue_estimate_currency: string | null;
  estimate_span: string | null; estimates_fetched_at: string | null;
  prev_move_pct: number | null; prev_move_date: string | null; prev_move_basis: string | null; prev_move_checked_at: string | null;
  calendar_fetched_at: string | null;
  s_name: string; s_isin: string | null; s_country: string | null; s_level: string; s_adr: string | null; s_adr_ratio: number | null;
  s_adr_ratio_verified: number; s_sector: string | null; s_industry: string | null; s_market_cap: number | null;
  s_market_cap_currency: string | null; s_market_cap_as_of: string | null;
  em_adr: string | null; em_expiry: string | null; em_strike: number | null; em_call_mid: number | null; em_put_mid: number | null;
  em_underlying: number | null; em_move_pct: number | null; em_illiquid: number | null; em_final: number | null;
  em_quote_date: string | null; em_snapshot_at: string | null;
  lm_move_pct: number | null; lm_illiquid: number | null; lm_quote_time: string | null;
}

const SELECT_COLUMNS = `
SELECT r.*,
  ${SERVED_NAME('s')} AS s_name, s.isin AS s_isin, s.country AS s_country, s.level AS s_level, s.adr AS s_adr,
  s.adr_ratio AS s_adr_ratio, s.adr_ratio_verified AS s_adr_ratio_verified, s.sector AS s_sector, s.industry AS s_industry,
  s.market_cap AS s_market_cap, s.market_cap_currency AS s_market_cap_currency, s.market_cap_as_of AS s_market_cap_as_of,
  m.adr AS em_adr, m.expiry AS em_expiry, m.strike AS em_strike, m.call_mid AS em_call_mid, m.put_mid AS em_put_mid,
  m.underlying AS em_underlying, m.move_pct AS em_move_pct, m.illiquid AS em_illiquid, m.final AS em_final,
  m.quote_date AS em_quote_date, m.snapshot_at AS em_snapshot_at,
  l.move_pct AS lm_move_pct, l.illiquid AS lm_illiquid, l.quote_time AS lm_quote_time
FROM europe_reports r
JOIN europe_stocks s ON s.symbol = r.symbol`;
const SELECT_JOINS = `
LEFT JOIN europe_expected_moves m ON m.report_id = r.id
LEFT JOIN europe_live_moves l ON l.report_id = r.id`;
/** The calendar shows only stocks in the current universe. */
const SELECT_ACTIVE = `${SELECT_COLUMNS} AND s.active = 1${SELECT_JOINS}`;
/** Any stock with reports (watchlists, single rows). */
const SELECT_ANY = `${SELECT_COLUMNS}${SELECT_JOINS}`;

const asSource = (s: string | null): EuropeActualSource | null => (s === 'sec' || s === 'esef' || s === 'yahoo' ? s : null);
const asSpan = (s: string | null): EuropeSpan | null => (s === 'quarter' || s === 'ytd' ? s : null);
const asMonths = (n: number | null): EuropeYtdMonths | null => (n === 6 || n === 9 || n === 12 ? n : null);
const asTimingSource = (s: string | null): EuropeTimingSource | null => (s === 'sec-notice' || s === 'prn' || s === 'yahoo' ? s : null);
const asReleaseSource = (s: string | null): EuropeReleaseSource | null =>
  (s === 'sec' || s === 'prn' || s === 'dila' || s === 'yahoo' ? s : null);

function toEuropeReport(r: ReportRow): EuropeReport {
  return {
    id: r.id,
    market: r.market === 'UK' ? 'UK' : 'EU',
    symbol: r.symbol,
    name: r.s_name,
    exchange: r.exchange as ExchangeId,
    isin: r.s_isin,
    country: r.s_country,
    periodEnd: r.period_end,
    fiscalQuarter: r.fiscal_quarter as 1 | 2 | 3 | 4,
    fyEnd: r.fy_end,
    periodLabel: r.period_label,
    periodConfirmed: r.period_confirmed === 1,
    reportDate: r.report_date,
    dateStatus: r.date_status === 'confirmed' ? 'confirmed' : 'estimated',
    rescheduledFrom: r.rescheduled_from,
    timing: r.timing as LocalTiming,
    timingSource: asTimingSource(r.timing_source),
    releasedAt: r.released_at,
    releasedSource: asReleaseSource(r.released_source),
    signalTitle: r.signal_title,
    signalUrl: r.signal_url,
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
    esefUrl: r.esef_url,
    epsEstimate: r.eps_estimate,
    epsAnalysts: r.eps_analysts,
    epsEstimateCurrency: r.eps_estimate_currency,
    revenueEstimate: r.revenue_estimate,
    revenueAnalysts: r.revenue_analysts,
    revenueEstimateCurrency: r.revenue_estimate_currency,
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
    adrRatioVerified: r.s_adr_ratio_verified === 1,
    sector: r.s_sector,
    industry: r.s_industry,
    marketCap: r.s_market_cap,
    marketCapCurrency: r.s_market_cap_currency,
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

const findReport = (db: DatabaseSync, symbol: string, periodEnd: string) =>
  db.prepare('SELECT * FROM europe_reports WHERE symbol = ? AND period_end = ?').get(symbol, periodEnd) as unknown as ReportRow | undefined;

const properName = (name: string, symbol: string) => (name.trim() && name.trim() !== symbol ? name.trim() : null);

/** Results are out: a release signal recorded, or an EPS figure (basic or diluted) stored. */
const RELEASED_SQL = '(released_at IS NOT NULL OR eps_actual IS NOT NULL OR eps_diluted_actual IS NOT NULL)';

/**
 * A report date for a period (JP rules): confirmed dates never give way to estimated ones; once results are out the
 * date is fixed; a new confirmed date for an unreleased row is a reschedule (old date kept, timing back to unknown).
 * `periodConfirmed` only ever raises the flag: a later unconfirmed pass never clears it. Returns the report id.
 */
export function upsertEuropeCalendarRow(
  db: DatabaseSync, market: EuropeMarket,
  row: {
    symbol: string; name: string; exchange: ExchangeId; period: EuropePeriod; periodLabel: string; periodConfirmed: boolean;
    reportDate: string; dateStatus: 'confirmed' | 'estimated'; timing?: LocalTiming; timingSource?: EuropeTimingSource;
  },
  now: string,
): number {
  const timing = row.timing ?? 'UNKNOWN';
  const source = timing === 'UNKNOWN' ? null : row.timingSource ?? null;
  const confirmed = row.periodConfirmed ? 1 : 0;
  const existing = findReport(db, row.symbol, row.period.periodEnd);
  if (!existing) {
    const r = db.prepare(`INSERT INTO europe_reports (id, market, symbol, name, exchange, period_end, fiscal_quarter, fy_end, period_label,
        period_confirmed, report_date, date_status, timing, timing_source, calendar_fetched_at)
      VALUES ((SELECT COALESCE(MAX(id), ? - 1) + 1 FROM europe_reports WHERE market = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`)
      .get(idBase(market), market, market, row.symbol, properName(row.name, row.symbol) ?? row.symbol, row.exchange, row.period.periodEnd,
        row.period.fiscalQuarter, row.period.fyEnd, row.periodLabel, confirmed, row.reportDate, row.dateStatus, timing, source, now) as { id: number };
    return r.id;
  }

  const name = properName(row.name, row.symbol) ?? existing.name;
  const periodConfirmed = Math.max(existing.period_confirmed, confirmed);
  const released = existing.released_at != null || existing.eps_actual != null || existing.eps_diluted_actual != null;
  const weaker = row.dateStatus === 'estimated' && existing.date_status === 'confirmed';
  if (released || weaker || existing.report_date === row.reportDate) {
    const confirms = !released && existing.report_date === row.reportDate && row.dateStatus === 'confirmed';
    const status = confirms ? 'confirmed' : existing.date_status;
    const setTiming = !released && !weaker && timing !== 'UNKNOWN' && existing.timing === 'UNKNOWN';
    db.prepare(`UPDATE europe_reports SET name = ?, period_confirmed = ?, date_status = ?, timing = ?, timing_source = ?, calendar_fetched_at = ?
        WHERE id = ?`)
      .run(name, periodConfirmed, status, setTiming ? timing : existing.timing, setTiming ? source : existing.timing_source, now, existing.id);
    return existing.id;
  }
  db.prepare(`UPDATE europe_reports SET name = ?, period_confirmed = ?, report_date = ?, date_status = ?, timing = ?, timing_source = ?,
      rescheduled_from = CASE WHEN ? = 'confirmed' THEN ? ELSE rescheduled_from END, calendar_fetched_at = ? WHERE id = ?`)
    .run(name, periodConfirmed, row.reportDate, row.dateStatus, timing, source, existing.date_status, existing.report_date, now, existing.id);
  db.prepare('DELETE FROM europe_expected_moves WHERE report_id = ?').run(existing.id);
  db.prepare('DELETE FROM europe_live_moves WHERE report_id = ?').run(existing.id);
  return existing.id;
}

/** A source confirmed the row's period end (Ruling 7): its label may be shown. */
export function confirmEuropePeriod(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE europe_reports SET period_confirmed = 1 WHERE id = ?').run(id);
}

const TIMING_RANK: Record<EuropeTimingSource, number> = { 'sec-notice': 3, prn: 2, yahoo: 1 };
const timingRank = (s: string | null): number => (s === 'sec-notice' || s === 'prn' || s === 'yahoo' ? TIMING_RANK[s] : 0);

/**
 * Timing from a stated source (Ruling 9's order: a 6-K date notice > a PR Newswire timestamp > a Yahoo TAS time).
 * Written when the stored timing is unknown or comes from a lower source. An unreleased row only, except for `prn`:
 * the PR Newswire item is the release itself, so it may stamp a released row. Returns true if written.
 */
export function setEuropeTiming(db: DatabaseSync, id: number, timing: LocalTiming, source: EuropeTimingSource): boolean {
  if (timing === 'UNKNOWN') return false;
  const r = db.prepare(`SELECT timing, timing_source, ${RELEASED_SQL} AS released FROM europe_reports WHERE id = ?`).get(id) as
    { timing: string; timing_source: string | null; released: number } | undefined;
  if (!r) return false;
  if (r.released === 1 && source !== 'prn') return false;
  if (r.timing !== 'UNKNOWN' && TIMING_RANK[source] <= timingRank(r.timing_source)) return false;
  if (r.timing === timing && r.timing_source === source) return false;
  db.prepare('UPDATE europe_reports SET timing = ?, timing_source = ? WHERE id = ?').run(timing, source, id);
  return true;
}

/**
 * Results are out (Ruling 10): the earliest timestamp among sec / prn / dila / yahoo is kept with its source, title and
 * link (the winner's own pair, so a title never describes another source's release). A later signal never moves it.
 * Timing is only ever stated by a PR Newswire item (Ruling 9): `timing` from any other source is ignored.
 * Returns true if anything was written.
 */
export function recordEuropeRelease(
  db: DatabaseSync, id: number,
  r: { at: string; source: EuropeReleaseSource; timing: LocalTiming | null; title?: string | null; url?: string | null },
): boolean {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return false;
  const row = db.prepare('SELECT released_at FROM europe_reports WHERE id = ?').get(id) as { released_at: string | null } | undefined;
  if (!row) return false;
  if (row.released_at) {
    const stored = Date.parse(row.released_at);
    if (!Number.isFinite(stored)) {
      // Never overwrite a stored value we cannot read: keep it and say so.
      console.warn(`europe release: report ${id} has an unparseable released_at; kept, ${r.source} signal ignored`);
      return false;
    }
    if (stored <= at) return false;
  }
  db.prepare('UPDATE europe_reports SET released_at = ?, released_source = ?, signal_title = ?, signal_url = ? WHERE id = ?')
    .run(r.at, r.source, r.title?.trim() || null, httpUrlOrNull(r.url), id);
  if (r.source === 'prn' && r.timing && r.timing !== 'UNKNOWN') setEuropeTiming(db, id, r.timing, 'prn');
  return true;
}

/** The unreleased report of `symbol` (any period) dated nearest to `day`, within `windowDays` calendar days. */
export function nearestUnreleasedEurope(
  db: DatabaseSync, symbol: string, day: string, windowDays = 3,
): { id: number; reportDate: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4 } | null {
  const r = db.prepare(`SELECT id, report_date AS reportDate, period_end AS periodEnd, fiscal_quarter AS fiscalQuarter FROM europe_reports
    WHERE symbol = ? AND NOT ${RELEASED_SQL} AND abs(julianday(report_date) - julianday(?)) <= ?
    ORDER BY abs(julianday(report_date) - julianday(?)), report_date LIMIT 1`).get(symbol, day, windowDays, day) as
    { id: number; reportDate: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4 } | undefined;
  return r ?? null;
}

/**
 * Released reports of `symbol` (released as `nearestUnreleasedEurope` defines it: a release signal or an EPS figure)
 * dated within `windowDays` of `day`, nearest first. `releasedAt` is null when only an EPS figure marks the release.
 */
export function releasedEuropeNear(
  db: DatabaseSync, symbol: string, day: string, windowDays = 3,
): { id: number; releasedAt: string | null }[] {
  return db.prepare(`SELECT id, released_at AS releasedAt FROM europe_reports
    WHERE symbol = ? AND ${RELEASED_SQL} AND abs(julianday(report_date) - julianday(?)) <= ?
    ORDER BY abs(julianday(report_date) - julianday(?)), report_date`).all(symbol, day, windowDays, day) as
    { id: number; releasedAt: string | null }[];
}

export function findEuropeReportId(db: DatabaseSync, symbol: string, periodEnd: string): number | null {
  return findReport(db, symbol, periodEnd)?.id ?? null;
}

/**
 * The report came out on another day than the calendar said: the old date is kept, move snapshots reset. Timing
 * resets too, unless `keepTiming` (a timing stated by a filing notice is never reset).
 */
export function moveEuropeReportDate(db: DatabaseSync, id: number, newDate: string, opts: { keepTiming?: boolean } = {}): void {
  if (opts.keepTiming) {
    db.prepare('UPDATE europe_reports SET rescheduled_from = report_date, report_date = ? WHERE id = ? AND report_date IS NOT ?').run(newDate, id, newDate);
  } else {
    db.prepare(`UPDATE europe_reports SET rescheduled_from = report_date, report_date = ?, timing = 'UNKNOWN', timing_source = NULL
        WHERE id = ? AND report_date IS NOT ?`).run(newDate, id, newDate);
  }
  db.prepare('DELETE FROM europe_expected_moves WHERE report_id = ?').run(id);
  db.prepare('DELETE FROM europe_live_moves WHERE report_id = ?').run(id);
}

const RANK: Record<EuropeActualSource, number> = { sec: 3, esef: 2, yahoo: 1 };
const rankOf = (s: string | null): number => (s === 'sec' || s === 'esef' || s === 'yahoo' ? RANK[s] : 0);
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Actuals, per field group (revenue; basic + diluted EPS), each with its own source, currency and span (JP rules):
 * SEC > ESEF > Yahoo; a group is written when nothing is stored for it or the incoming source ranks higher; an equal
 * or lower source never writes (the first of a source wins); a group without a value never blanks a stored one; a
 * diluted-only EPS group is stored only when the row has no EPS; a stored diluted-only group takes a matching basic.
 * Currencies are stored as stated ('GBp' pence ≠ 'GBP' pounds; EPS and revenue currencies are independent).
 * `docUrl` (SEC) / `esefUrl` are written when none is stored, or with a group their source wrote. A written group
 * confirms the period (Ruling 7: the row's own released actual). Returns true if anything changed.
 */
export function mergeEuropeActuals(
  db: DatabaseSync, id: number,
  a: {
    revenue?: { value: number; currency: string; span: EuropeSpan; ytdMonths: EuropeYtdMonths | null } | null;
    eps?: { basic: number | null; diluted: number | null; currency: string; span: EuropeSpan; ytdMonths: EuropeYtdMonths | null } | null;
    source: EuropeActualSource; docUrl?: string | null; esefUrl?: string | null;
  },
  _now: string,
): boolean {
  const r = db.prepare(`SELECT revenue_actual, revenue_source, eps_actual, eps_diluted_actual, eps_source, eps_currency, eps_span,
      eps_ytd_months, sec_doc_url, esef_url
    FROM europe_reports WHERE id = ?`).get(id) as
    { revenue_actual: number | null; revenue_source: string | null; eps_actual: number | null; eps_diluted_actual: number | null;
      eps_source: string | null; eps_currency: string | null; eps_span: string | null; eps_ytd_months: number | null;
      sec_doc_url: string | null; esef_url: string | null } | undefined;
  if (!r) return false;
  const rank = RANK[a.source];
  let changed = false;
  let wrote = false;

  const rev = a.revenue;
  if (rev && finite(rev.value) && rev.currency && (r.revenue_actual == null || rank > rankOf(r.revenue_source))) {
    db.prepare(`UPDATE europe_reports SET revenue_actual = ?, revenue_currency = ?, revenue_source = ?, revenue_span = ?, revenue_ytd_months = ?
        WHERE id = ?`).run(rev.value, rev.currency, a.source, rev.span, rev.span === 'ytd' ? rev.ytdMonths : null, id);
    changed = wrote = true;
  }

  const eps = a.eps;
  if (eps && eps.currency) {
    const basic = finite(eps.basic) ? eps.basic : null;
    const diluted = finite(eps.diluted) ? eps.diluted : null;
    const stored = r.eps_actual != null || r.eps_diluted_actual != null;
    const ok = basic != null ? !stored || rank > rankOf(r.eps_source) : diluted != null && !stored;
    const months = eps.span === 'ytd' ? eps.ytdMonths : null;
    const fillsBasic = !ok && basic != null && r.eps_actual == null && r.eps_diluted_actual != null
      && eps.currency === r.eps_currency && eps.span === r.eps_span && months === r.eps_ytd_months;
    if (ok) {
      db.prepare(`UPDATE europe_reports SET eps_actual = ?, eps_diluted_actual = ?, eps_currency = ?, eps_source = ?, eps_span = ?,
          eps_ytd_months = ? WHERE id = ?`).run(basic, diluted, eps.currency, a.source, eps.span, months, id);
      changed = wrote = true;
    } else if (fillsBasic) {
      const source = rank < rankOf(r.eps_source) ? a.source : r.eps_source;
      db.prepare('UPDATE europe_reports SET eps_actual = ?, eps_source = ? WHERE id = ?').run(basic, source, id);
      changed = wrote = true;
    }
  }

  if (a.docUrl && a.docUrl !== r.sec_doc_url && (r.sec_doc_url == null || (wrote && a.source === 'sec'))) {
    db.prepare('UPDATE europe_reports SET sec_doc_url = ? WHERE id = ?').run(a.docUrl, id);
    changed = true;
  }
  if (a.esefUrl && a.esefUrl !== r.esef_url && (r.esef_url == null || (wrote && a.source === 'esef'))) {
    db.prepare('UPDATE europe_reports SET esef_url = ? WHERE id = ?').run(a.esefUrl, id);
    changed = true;
  }
  if (wrote) db.prepare('UPDATE europe_reports SET period_confirmed = 1 WHERE id = ?').run(id);
  return changed;
}

/**
 * Consensus, with an EPS currency and a revenue currency as Yahoo states each (never converted). A side whose
 * currency is unknown is skipped (uncertain means blank). A missing figure never blanks a stored one, except:
 * a span change (quarter / year) writes every value (nulls for the missing), and a currency change on one side writes
 * that side's value, analysts and currency together, so two units never sit in one figure.
 */
export function setEuropeEstimates(
  db: DatabaseSync, id: number,
  e: {
    eps: number | null; epsAnalysts: number | null; epsCurrency: string | null; revenue: number | null; revenueAnalysts: number | null;
    revenueCurrency: string | null; span: EuropeEstimateSpan;
  },
  now: string,
): void {
  const stored = db.prepare('SELECT eps_estimate_currency, revenue_estimate_currency, estimate_span FROM europe_reports WHERE id = ?').get(id) as
    { eps_estimate_currency: string | null; revenue_estimate_currency: string | null; estimate_span: string | null } | undefined;
  if (!stored) return;
  const epsCcy = e.epsCurrency?.trim() || null;
  const revCcy = e.revenueCurrency?.trim() || null;
  if (epsCcy == null && revCcy == null) return;
  const eps = epsCcy ? e.eps : null;
  const epsN = epsCcy ? e.epsAnalysts : null;
  const rev = revCcy ? e.revenue : null;
  const revN = revCcy ? e.revenueAnalysts : null;
  if (stored.estimate_span != null && stored.estimate_span !== e.span) {
    db.prepare(`UPDATE europe_reports SET eps_estimate = ?, eps_analysts = ?, eps_estimate_currency = ?, revenue_estimate = ?,
        revenue_analysts = ?, revenue_estimate_currency = ?, estimate_span = ?, estimates_fetched_at = ? WHERE id = ?`)
      .run(eps, epsN, epsCcy, rev, revN, revCcy, e.span, now, id);
    return;
  }
  const side = (value: string, analysts: string, ccyCol: string, v: number | null, n: number | null, ccy: string | null, storedCcy: string | null) => {
    if (ccy == null) return;
    if (storedCcy != null && storedCcy !== ccy) {
      db.prepare(`UPDATE europe_reports SET ${value} = ?, ${analysts} = ?, ${ccyCol} = ? WHERE id = ?`).run(v, n, ccy, id);
    } else {
      db.prepare(`UPDATE europe_reports SET ${value} = COALESCE(?, ${value}), ${analysts} = COALESCE(?, ${analysts}),
          ${ccyCol} = CASE WHEN COALESCE(?, ${value}) IS NULL THEN ${ccyCol} ELSE ? END WHERE id = ?`).run(v, n, v, ccy, id);
    }
  };
  side('eps_estimate', 'eps_analysts', 'eps_estimate_currency', eps, epsN, epsCcy, stored.eps_estimate_currency);
  side('revenue_estimate', 'revenue_analysts', 'revenue_estimate_currency', rev, revN, revCcy, stored.revenue_estimate_currency);
  db.prepare('UPDATE europe_reports SET estimate_span = ?, estimates_fetched_at = ? WHERE id = ?').run(e.span, now, id);
}

// ---------- Lists ----------

/** `q` matches the symbol, the ISIN, the name (universe or Yahoo) or the ADR ticker; `exchange` narrows to one exchange. */
export function listEuropeRange(
  db: DatabaseSync, market: EuropeMarket, f: { from: string; to: string; q: string | null; exchange: ExchangeId | null },
): EuropeReport[] {
  const where = ['r.market = ?', 'r.report_date BETWEEN ? AND ?'];
  const params: (string | number)[] = [market, f.from, f.to];
  if (f.exchange) {
    where.push('r.exchange = ?');
    params.push(f.exchange);
  }
  const term = f.q?.replace(/[%_]/g, '').trim();
  if (term) {
    where.push('(r.symbol LIKE ? OR s.isin LIKE ? OR r.name LIKE ? OR s.name LIKE ? OR s.profile_name LIKE ? OR s.adr LIKE ?)');
    params.push(`${term}%`, `${term.toUpperCase()}%`, `%${term}%`, `%${term}%`, `%${term}%`, `${term.toUpperCase()}%`);
  }
  const rows = db.prepare(`${SELECT_ACTIVE} WHERE ${where.join(' AND ')} ORDER BY r.report_date, r.symbol`)
    .all(...params) as unknown as ReportRow[];
  return rows.map(toEuropeReport);
}

/** Reports of the given symbols dated in [from, to], in the universe or not (watchlists). */
export function listEuropeForSymbols(db: DatabaseSync, market: EuropeMarket, symbols: string[], from: string, to: string): EuropeReport[] {
  if (symbols.length === 0) return [];
  const rows = db.prepare(`${SELECT_ANY} WHERE r.market = ? AND r.symbol IN (${symbols.map(() => '?').join(',')})
      AND r.report_date BETWEEN ? AND ? ORDER BY r.report_date, r.symbol`).all(market, ...symbols, from, to) as unknown as ReportRow[];
  return rows.map(toEuropeReport);
}

export function getEuropeReport(db: DatabaseSync, id: number): EuropeReport | undefined {
  const r = db.prepare(`${SELECT_ANY} WHERE r.id = ?`).get(id) as unknown as ReportRow | undefined;
  return r && toEuropeReport(r);
}

// ---------- Moves ----------

/** An ADR straddle snapshot. A final one (taken at the last US close before release) is never replaced. */
export function saveEuropeExpectedMove(
  db: DatabaseSync, id: number, em: ExpectedMove & { adr: string; quoteDate: string }, final: boolean, now: string,
): boolean {
  const prev = db.prepare('SELECT final FROM europe_expected_moves WHERE report_id = ?').get(id) as { final: number } | undefined;
  if (prev?.final === 1) return false;
  db.prepare(`INSERT OR REPLACE INTO europe_expected_moves
    (report_id, adr, expiry, strike, call_mid, put_mid, underlying, move_pct, illiquid, final, quote_date, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, em.adr, em.expiry, em.strike, em.callMid, em.putMid, em.underlying, em.movePct, em.illiquid ? 1 : 0, final ? 1 : 0, em.quoteDate, now,
  );
  return true;
}

export function saveEuropeLiveMove(
  db: DatabaseSync, id: number, m: { movePct: number; illiquid: boolean; quoteTime: string | null }, now: string,
): boolean {
  const prev = db.prepare('SELECT move_pct AS p FROM europe_live_moves WHERE report_id = ?').get(id) as { p: number } | undefined;
  db.prepare(`INSERT OR REPLACE INTO europe_live_moves (report_id, move_pct, illiquid, quote_time, fetched_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, m.movePct, m.illiquid ? 1 : 0, m.quoteTime, now);
  return prev?.p !== m.movePct;
}

/** The stored snapshot's quote date and finality, or null when none is stored. */
export function storedEuropeExpectedMove(db: DatabaseSync, id: number): { quoteDate: string; final: boolean } | null {
  const r = db.prepare('SELECT quote_date, final FROM europe_expected_moves WHERE report_id = ?').get(id) as
    { quote_date: string | null; final: number } | undefined;
  return r ? { quoteDate: r.quote_date ?? '', final: r.final === 1 } : null;
}

/** Records a check; a found move is stored, a miss never blanks an earlier value. */
export function setEuropePrevMove(
  db: DatabaseSync, id: number, move: { pct: number; date: string; basis: 'known' | 'assumed' } | null, now: string,
): void {
  if (move) {
    db.prepare('UPDATE europe_reports SET prev_move_pct = ?, prev_move_date = ?, prev_move_basis = ?, prev_move_checked_at = ? WHERE id = ?')
      .run(move.pct, move.date, move.basis, now, id);
  } else {
    db.prepare('UPDATE europe_reports SET prev_move_checked_at = ? WHERE id = ?').run(now, id);
  }
}

// ---------- Job queries ----------

export interface EuropePending {
  id: number;
  symbol: string;
  exchange: ExchangeId;
  reportDate: string;
  timing: LocalTiming;
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

/** Reports of the market's universe stocks dated in the range. */
export function europeReportsBetween(db: DatabaseSync, market: EuropeMarket, from: string, to: string): EuropePending[] {
  const rows = db.prepare(`SELECT r.id, r.symbol, r.exchange, r.report_date AS reportDate, r.timing, r.period_end AS periodEnd,
      r.fiscal_quarter AS fiscalQuarter, r.released_at AS releasedAt, s.level, s.adr, s.cik,
      (r.eps_actual IS NOT NULL OR r.eps_diluted_actual IS NOT NULL) AS hasEps,
      r.revenue_actual IS NOT NULL AS hasRevenue, COALESCE(m.final, 0) AS expectedFinal
    FROM europe_reports r JOIN europe_stocks s ON s.symbol = r.symbol AND s.active = 1
    LEFT JOIN europe_expected_moves m ON m.report_id = r.id
    WHERE r.market = ? AND r.report_date BETWEEN ? AND ? ORDER BY r.report_date, r.symbol`).all(market, from, to) as unknown as
    (Omit<EuropePending, 'hasEps' | 'hasRevenue' | 'expectedFinal' | 'level'>
      & { level: string; hasEps: number; hasRevenue: number; expectedFinal: number })[];
  return rows.map((r) => ({
    ...r, level: r.level === 'full' ? 'full' : 'basic', hasEps: r.hasEps === 1, hasRevenue: r.hasRevenue === 1,
    expectedFinal: r.expectedFinal === 1,
  }));
}

/** Reports with no previous move yet, not checked since `recheckBefore`. */
export function europeReportsNeedingPrevMove(
  db: DatabaseSync, market: EuropeMarket, from: string, to: string, recheckBefore: string,
): { id: number; symbol: string; exchange: ExchangeId; reportDate: string; timing: LocalTiming; adr: string | null }[] {
  return db.prepare(`SELECT r.id, r.symbol, r.exchange, r.report_date AS reportDate, r.timing, s.adr FROM europe_reports r
    JOIN europe_stocks s ON s.symbol = r.symbol AND s.active = 1
    WHERE r.market = ? AND r.report_date BETWEEN ? AND ? AND r.prev_move_pct IS NULL
      AND (r.prev_move_checked_at IS NULL OR r.prev_move_checked_at < ?)`)
    .all(market, from, to, recheckBefore) as unknown as
    { id: number; symbol: string; exchange: ExchangeId; reportDate: string; timing: LocalTiming; adr: string | null }[];
}

/** The latest earlier report of `symbol` whose results are out. */
export function priorEuropeReleased(
  db: DatabaseSync, symbol: string, before: string,
): { reportDate: string; timing: LocalTiming; known: boolean; releasedAt: string | null; releasedSource: EuropeReleaseSource | null } | null {
  const r = db.prepare(`SELECT report_date, timing, released_at, released_source FROM europe_reports
    WHERE symbol = ? AND report_date < ? AND ${RELEASED_SQL}
    ORDER BY report_date DESC LIMIT 1`).get(symbol, before) as
    { report_date: string; timing: string; released_at: string | null; released_source: string | null } | undefined;
  return r ? {
    reportDate: r.report_date, timing: r.timing as LocalTiming, known: r.released_at != null && r.timing !== 'UNKNOWN',
    releasedAt: r.released_at, releasedSource: r.released_source as EuropeReleaseSource | null,
  } : null;
}

/**
 * Past result dates from the Yahoo bulk sweep. Idempotent: a known timing fills an unknown one and a null never
 * blanks a stored timing. Returns the number of dates newly added.
 */
export function upsertEuropePastDates(db: DatabaseSync, rows: { symbol: string; date: string; timing: LocalTiming | null }[]): number {
  const exists = db.prepare('SELECT 1 FROM europe_past_dates WHERE symbol = ? AND date = ?');
  const up = db.prepare(`INSERT INTO europe_past_dates (symbol, date, timing) VALUES (?, ?, ?)
    ON CONFLICT (symbol, date) DO UPDATE SET timing = COALESCE(excluded.timing, timing)`);
  return inTx(db, () => {
    let added = 0;
    for (const r of rows) {
      if (!exists.get(r.symbol, r.date)) added++;
      up.run(r.symbol, r.date, r.timing && r.timing !== 'UNKNOWN' ? r.timing : null);
    }
    return added;
  });
}

/** Past result dates of `symbol`, newest first. */
export function europePastDates(db: DatabaseSync, symbol: string): { date: string; timing: LocalTiming | null }[] {
  return db.prepare('SELECT date, timing FROM europe_past_dates WHERE symbol = ? ORDER BY date DESC').all(symbol) as unknown as
    { date: string; timing: LocalTiming | null }[];
}

/** Past dates stored for the market's stocks. */
export function europePastDatesCount(db: DatabaseSync, market: EuropeMarket): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM europe_past_dates p JOIN europe_stocks s ON s.symbol = p.symbol WHERE s.market = ?`)
    .get(market) as { n: number }).n;
}

// ---------- SEC bookkeeping (per market: one filing can serve HK and UK) ----------

export function europeSecSeen(db: DatabaseSync, market: EuropeMarket, accession: string): boolean {
  return db.prepare('SELECT 1 FROM europe_sec_seen WHERE market = ? AND accession = ?').get(market, accession) != null;
}

export function markEuropeSecSeen(
  db: DatabaseSync, market: EuropeMarket, accession: string, cik: number | null, kind: 'results' | 'date-notice' | 'other', now: string,
): void {
  db.prepare('INSERT OR IGNORE INTO europe_sec_seen (market, accession, cik, kind, seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(market, accession, cik, kind, now);
}

// ---------- Universe builds ----------

/** A complete universe build of `market` was synced: its left-out count and time replace the stored ones. */
export function saveEuropeUniverseRun(db: DatabaseSync, market: EuropeMarket, leftOut: number, at: string): void {
  db.prepare(`INSERT INTO europe_universe_runs (market, left_out, built_at) VALUES (?, ?, ?)
    ON CONFLICT (market) DO UPDATE SET left_out = excluded.left_out, built_at = excluded.built_at`).run(market, leftOut, at);
}

/** The last complete build of `market`, or null when none was ever recorded. */
export function lastEuropeUniverseRun(db: DatabaseSync, market: EuropeMarket): { leftOut: number; at: string } | null {
  const r = db.prepare('SELECT left_out, built_at FROM europe_universe_runs WHERE market = ?').get(market) as
    { left_out: number; built_at: string } | undefined;
  return r ? { leftOut: r.left_out, at: r.built_at } : null;
}

export function lastEuropeSecSeenAt(db: DatabaseSync, market: EuropeMarket): string | null {
  return (db.prepare('SELECT MAX(seen_at) AS t FROM europe_sec_seen WHERE market = ?').get(market) as { t: string | null }).t;
}

// ---------- Fast-signal bookkeeping (PR Newswire, DILA) ----------

/** `timing`: a PRN item whose row an earlier signal already released; only its timing was used. */
export type SignalOutcome = 'flipped' | 'timing' | 'no-match' | 'ambiguous' | 'not-results' | 'no-row' | 'done' | 'failed' | 'error';

/** Every active stock of both markets, with its universe and Yahoo profile names (the fast-signal issuer index). */
export function europeIssuerStocks(db: DatabaseSync): {
  symbol: string; market: EuropeMarket; exchange: ExchangeId; isin: string | null; lei: string | null; name: string; profileName: string | null;
}[] {
  return db.prepare(`SELECT symbol, market, exchange, isin, lei, name, profile_name AS profileName FROM europe_stocks WHERE active = 1
    ORDER BY symbol`).all() as unknown as {
    symbol: string; market: EuropeMarket; exchange: ExchangeId; isin: string | null; lei: string | null; name: string; profileName: string | null;
  }[];
}

/** Active stocks of the market carrying this ISIN (more than one means the ISIN cannot name one line). */
export function activeEuropeStocksByIsin(db: DatabaseSync, market: EuropeMarket, isin: string): { symbol: string; exchange: ExchangeId }[] {
  return db.prepare('SELECT symbol, exchange FROM europe_stocks WHERE market = ? AND active = 1 AND isin = ? ORDER BY symbol')
    .all(market, isin) as unknown as { symbol: string; exchange: ExchangeId }[];
}

export function signalSeen(db: DatabaseSync, source: string, itemId: string): boolean {
  return db.prepare('SELECT 1 FROM europe_signal_seen WHERE source = ? AND item_id = ?').get(source, itemId) != null;
}

/** The first outcome of an item is kept. */
export function markSignalSeen(db: DatabaseSync, source: string, itemId: string, symbol: string | null, outcome: SignalOutcome, now: string): void {
  db.prepare('INSERT OR IGNORE INTO europe_signal_seen (source, item_id, symbol, outcome, seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(source, itemId, symbol, outcome, now);
}

/** Rows of `source` whose item id starts with `prefix` (the DILA per-day failure count). */
export function signalCountWithPrefix(db: DatabaseSync, source: string, prefix: string): number {
  const rows = db.prepare('SELECT item_id FROM europe_signal_seen WHERE source = ?').all(source) as { item_id: string }[];
  return rows.filter((r) => r.item_id.startsWith(prefix)).length;
}

export function lastSignalAt(db: DatabaseSync, source: string): string | null {
  return (db.prepare('SELECT MAX(seen_at) AS t FROM europe_signal_seen WHERE source = ?').get(source) as { t: string | null }).t;
}

// ---------- ESEF bookkeeping ----------

/**
 * `merged`: actuals written. `no-row` / `blank`: final. A fetch error is not recorded while the filing can still be
 * retried; once it falls behind the job's paging window it is recorded `error-dropped` (a trace, never retried).
 */
export type EsefOutcome = 'merged' | 'superseded' | 'no-row' | 'blank' | 'error-dropped';

/** True when an annual period later than `periodEnd` was already handled (with a 12-month figure) for any of `symbols`. */
export function esefLaterPeriodHeld(db: DatabaseSync, symbols: readonly string[], periodEnd: string): boolean {
  if (symbols.length === 0) return false;
  return db.prepare(`SELECT 1 FROM europe_esef_seen WHERE symbol IN (${symbols.map(() => '?').join(', ')}) AND period_end > ?
    AND outcome IN ('merged', 'superseded', 'no-row') LIMIT 1`).get(...symbols, periodEnd) != null;
}

export function esefSeen(db: DatabaseSync, fxoId: string): boolean {
  return db.prepare('SELECT 1 FROM europe_esef_seen WHERE fxo_id = ?').get(fxoId) != null;
}

/** `dateAdded` is the filing's filings.xbrl.org `date_added`, kept for paging (`lastEsefDateAdded`). */
export function markEsefSeen(
  db: DatabaseSync, fxoId: string, symbol: string | null, periodEnd: string | null, outcome: EsefOutcome, now: string,
  dateAdded?: string | null,
): void {
  db.prepare('INSERT OR IGNORE INTO europe_esef_seen (fxo_id, symbol, period_end, outcome, seen_at, date_added) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fxoId, symbol, periodEnd, outcome, now, dateAdded?.trim() || null);
}

/**
 * The latest filings.xbrl.org `date_added` among handled filings (the ESEF job's `since`); with `market`, only
 * filings matched to that market's stocks. Null when none is recorded.
 */
export function lastEsefDateAdded(db: DatabaseSync, market?: EuropeMarket): string | null {
  if (!market) return (db.prepare('SELECT MAX(date_added) AS t FROM europe_esef_seen').get() as { t: string | null }).t;
  return (db.prepare(`SELECT MAX(e.date_added) AS t FROM europe_esef_seen e JOIN europe_stocks s ON s.symbol = e.symbol WHERE s.market = ?`)
    .get(market) as { t: string | null }).t;
}

/** The last ESEF filing handled; with `market`, only filings matched to that market's stocks. */
export function lastEsefAt(db: DatabaseSync, market?: EuropeMarket): string | null {
  if (!market) return (db.prepare('SELECT MAX(seen_at) AS t FROM europe_esef_seen').get() as { t: string | null }).t;
  return (db.prepare(`SELECT MAX(e.seen_at) AS t FROM europe_esef_seen e JOIN europe_stocks s ON s.symbol = e.symbol WHERE s.market = ?`)
    .get(market) as { t: string | null }).t;
}

// ---------- OpenFIGI cache ----------

export interface FigiCacheRow {
  tickers: string[];
  yahooSymbol: string | null;
  outcome: string;
  checkedAt: string;
}

export function figiCached(db: DatabaseSync, isin: string, exchCode: string): FigiCacheRow | null {
  const r = db.prepare('SELECT tickers_json, yahoo_symbol, outcome, checked_at FROM europe_figi WHERE isin = ? AND exch_code = ?')
    .get(isin, exchCode) as { tickers_json: string; yahoo_symbol: string | null; outcome: string; checked_at: string } | undefined;
  if (!r) return null;
  let tickers: unknown;
  try {
    tickers = JSON.parse(r.tickers_json);
  } catch {
    return null;
  }
  if (!Array.isArray(tickers) || !tickers.every((t) => typeof t === 'string')) return null;
  return { tickers, yahooSymbol: r.yahoo_symbol, outcome: r.outcome, checkedAt: r.checked_at };
}

/** Stores an OpenFIGI answer. Callers never store a failed request (that is no answer, not "no ticker"). */
export function saveFigi(
  db: DatabaseSync, a: { isin: string; exchCode: string; tickers: string[]; yahooSymbol?: string | null; outcome: string }, now: string,
): void {
  db.prepare(`INSERT OR REPLACE INTO europe_figi (isin, exch_code, tickers_json, yahoo_symbol, outcome, checked_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(a.isin, a.exchCode, JSON.stringify(a.tickers), a.yahooSymbol ?? null, a.outcome, now);
}

/** A stored Yahoo ISIN search answer (`symbols` [] = confirmed no match), or null when none or unreadable. */
export function isinSearchCached(db: DatabaseSync, isin: string): { symbols: string[]; checkedAt: string } | null {
  const r = db.prepare('SELECT symbols_json, checked_at FROM europe_isin_search WHERE isin = ?').get(isin) as
    { symbols_json: string; checked_at: string } | undefined;
  if (!r) return null;
  let symbols: unknown;
  try {
    symbols = JSON.parse(r.symbols_json);
  } catch {
    return null;
  }
  if (!Array.isArray(symbols) || !symbols.every((s) => typeof s === 'string')) return null;
  return { symbols, checkedAt: r.checked_at };
}

/** Stores a Yahoo ISIN search answer. Callers never store a failed search (that is no answer, not "no match"). */
export function saveIsinSearch(db: DatabaseSync, isin: string, symbols: string[], now: string): void {
  db.prepare('INSERT OR REPLACE INTO europe_isin_search (isin, symbols_json, checked_at) VALUES (?, ?, ?)').run(isin, JSON.stringify(symbols), now);
}

// ---------- Bank holidays (gov.uk, England and Wales) ----------

/** Replaces the stored set with a fresh, parsed gov.uk list. An empty list is refused: a failed fetch keeps the stored dates. */
export function saveBankHolidays(db: DatabaseSync, dates: { date: string; title: string }[], now: string): void {
  if (dates.length === 0) throw new Error('saveBankHolidays: empty list refused');
  inTx(db, () => {
    db.exec('DELETE FROM europe_bank_holidays');
    const ins = db.prepare('INSERT OR REPLACE INTO europe_bank_holidays (date, title, fetched_at) VALUES (?, ?, ?)');
    for (const d of dates) ins.run(d.date, d.title || null, now);
  });
}

export function storedBankHolidays(db: DatabaseSync): Set<string> {
  return new Set((db.prepare('SELECT date FROM europe_bank_holidays ORDER BY date').all() as { date: string }[]).map((r) => r.date));
}
