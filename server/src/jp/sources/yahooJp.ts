/**
 * Yahoo Finance for Tokyo listings. Every request goes through the one `YahooClient` (one session,
 * ≤ 1 request/s for all Japan Yahoo traffic).
 *
 * Live checks (2026-10-27):
 * - Bulk calendar: `POST /v1/finance/visualization` accepts `{ operator: 'eq', operands: ['region', 'jp'] }`
 *   (no fallback to ticker batches needed). Rows are `[ticker, companyshortname, startdatetime (UTC ISO),
 *   startdatetimetype, epsestimate, epsactual]`, in the order of `documents[0].columns`; `total` is in
 *   `finance.result[0].total`. Region `jp` also returns Sapporo (`.S`) and Fukuoka (`.F`) rows; they are dropped.
 *   Yahoo reads the date bounds as US Eastern dates (`"2025-06-01"` → `2025-06-01T00:00-04:00`), so the
 *   query asks one day more on each side and the rows are cut to the window by their mapped date.
 *   CAUTION: Yahoo's Japan rows in this dataset largely stop after May 2025. A query for
 *   2025-09-22..2026-10-27 returned 6 rows, and none exist after 2026-01-14 (the US region is current
 *   into 2027). The saved fixtures are therefore from 2025-06-01..2025-06-13 (185 rows).
 * - Batch quote: `GET /v7/finance/quote?symbols=…` (50 symbols) works with the crumb (no fallback needed).
 *   Unknown symbols are simply missing from `quoteResponse.result`; alphanumeric codes (285A.T) work.
 * - financialsChart.quarterly labels (checked on 7203.T March FY, 3382.T February FY, 9983.T August FY):
 *   the label is the calendar quarter containing the period end, e.g. a quarter ending 2025-11-30 is
 *   `"4Q2025"` and one ending 2026-02-28 is `"1Q2026"` (`jpRevenueQuarterLabel`).
 */
import { DateTime } from 'luxon';
import type { YahooClient } from '../../sources/yahooClient.js';
import { HttpError } from '../../sources/http.js';
import { parseYahooSummaryFor, type YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import { JST, jpTimingFromJst, type JpTiming } from '../domain/jpCalendar.js';

export interface YahooCalRow {
  /** Yahoo symbol, e.g. "7203.T". */
  symbol: string;
  /** TSE code, e.g. "7203" or "285A". */
  code: string;
  /** TAS rows: the JST date. Other rows: the UTC date of `startdatetime`. */
  date: string;
  /** TAS rows: from the JST clock. Other rows: UNKNOWN. */
  timing: JpTiming;
  /** Yahoo's `startdatetimetype` (TAS = time as supplied, TNS = time not supplied, …). */
  timeType: string;
  epsActual: number | null;
}

const VIZ_URL = 'https://query1.finance.yahoo.com/v1/finance/visualization';
const PAGE_SIZE = 100;
const MAX_PAGES = 80;
const INCLUDE_FIELDS = ['ticker', 'companyshortname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual'];

/** `wellFormed`: the page has a document with a rows array (an empty one included). */
interface RawPage { rows: unknown[][]; columns: string[] | null; total: number | null; wellFormed: boolean }

function readPage(json: unknown): RawPage {
  const result = (json as { finance?: { result?: unknown } } | null)?.finance?.result;
  const r0 = Array.isArray(result) ? (result[0] as { total?: unknown; documents?: unknown } | undefined) : undefined;
  const total = typeof r0?.total === 'number' ? r0.total : null;
  const doc = Array.isArray(r0?.documents) ? (r0.documents[0] as { rows?: unknown; columns?: unknown } | undefined) : undefined;
  const rows = Array.isArray(doc?.rows) ? doc.rows.filter((x): x is unknown[] => Array.isArray(x)) : [];
  const columns = Array.isArray(doc?.columns)
    ? doc.columns.map((c) => (c && typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : ''))
    : null;
  return { rows, columns, total, wellFormed: Array.isArray(doc?.rows) };
}

function toRow(row: unknown[], col: (id: string) => number): YahooCalRow | null {
  const symbol = row[col('ticker')];
  const start = row[col('startdatetime')];
  const type = row[col('startdatetimetype')];
  if (typeof symbol !== 'string' || typeof start !== 'string' || typeof type !== 'string') return null;
  const m = /^([0-9][0-9A-Z]{3})\.T$/.exec(symbol);
  if (!m) return null;
  const utc = DateTime.fromISO(start, { zone: 'utc' });
  if (!utc.isValid) return null;
  const eps = col('epsactual') >= 0 ? row[col('epsactual')] : null;
  const epsActual = typeof eps === 'number' && Number.isFinite(eps) ? eps : null;
  if (type === 'TAS') {
    const jst = utc.setZone(JST);
    return { symbol, code: m[1]!, date: jst.toISODate()!, timing: jpTimingFromJst(jst.toFormat('HH:mm')), timeType: type, epsActual };
  }
  return { symbol, code: m[1]!, date: utc.toISODate()!, timing: 'UNKNOWN', timeType: type, epsActual };
}

/** One page of the bulk calendar (Ruling 11). Rows not on Tokyo (not ending `.T`) are dropped. */
export function parseYahooCalendarPage(json: unknown): { rows: YahooCalRow[]; total: number | null } {
  const page = readPage(json);
  const ids = page.columns ?? INCLUDE_FIELDS;
  const col = (id: string) => ids.indexOf(id);
  return { rows: page.rows.flatMap((r) => toRow(r, col) ?? []), total: page.total };
}

const addDays = (d: string, n: number) => DateTime.fromISO(d, { zone: 'utc' }).plus({ days: n }).toISODate()!;

/**
 * Every Tokyo earnings row Yahoo lists with a date in [from, to] (YYYY-MM-DD, both inclusive). Pages of
 * 100 until `total` or an empty page, at most 80 pages. A failure mid-sweep returns the rows so far with
 * `complete: false`; so do a malformed page and reaching the page cap before the end.
 */
export async function fetchJpEarningsCalendar(y: YahooClient, from: string, to: string): Promise<{ rows: YahooCalRow[]; complete: boolean }> {
  const rows: YahooCalRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    let json: unknown;
    try {
      json = await y.postJson(VIZ_URL, {
        size: PAGE_SIZE, offset, sortField: 'startdatetime', sortType: 'ASC', entityIdType: 'earnings',
        includeFields: INCLUDE_FIELDS,
        query: { operator: 'and', operands: [
          { operator: 'gte', operands: ['startdatetime', addDays(from, -1)] },
          { operator: 'lt', operands: ['startdatetime', addDays(to, 2)] },
          { operator: 'eq', operands: ['region', 'jp'] },
        ] },
      });
    } catch {
      return { rows, complete: false };
    }
    const raw = readPage(json);
    // A 200 that is not a calendar page (an error body, a changed shape) is a failure, not the end of the list.
    if (!raw.wellFormed) return { rows, complete: false };
    const parsed = parseYahooCalendarPage(json);
    rows.push(...parsed.rows.filter((r) => r.date >= from && r.date <= to));
    if (raw.rows.length === 0) return { rows, complete: true };
    if (raw.total != null ? offset + PAGE_SIZE >= raw.total : raw.rows.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

export interface YahooQuote {
  symbol: string;
  price: number | null;
  prevClose: number | null;
  /** Epoch milliseconds of the quote. */
  time: number | null;
  currency: string | null;
  /** Only when currency === 'JPY'. */
  marketCap: number | null;
  name: string | null;
}

const QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const QUOTE_BATCH = 50;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

function parseQuotes(json: unknown): YahooQuote[] {
  const result = (json as { quoteResponse?: { result?: unknown } } | null)?.quoteResponse?.result;
  if (!Array.isArray(result)) return [];
  return result.flatMap((q: Record<string, unknown>) => {
    const symbol = str(q?.symbol);
    if (!symbol) return [];
    const currency = str(q.currency);
    const time = num(q.regularMarketTime);
    return [{
      symbol,
      price: num(q.regularMarketPrice),
      prevClose: num(q.regularMarketPreviousClose),
      time: time != null ? time * 1000 : null,
      currency,
      marketCap: currency === 'JPY' ? num(q.marketCap) : null,
      name: str(q.longName) ?? str(q.shortName)?.trim() ?? null,
    }];
  });
}

/** Batch quotes, 50 symbols per request. Symbols Yahoo does not know are absent from the map. A failed batch throws. */
export async function fetchYahooQuotes(y: YahooClient, symbols: string[]): Promise<Map<string, YahooQuote>> {
  const out = new Map<string, YahooQuote>();
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const batch = symbols.slice(i, i + QUOTE_BATCH);
    const json = await y.json(`${QUOTE_URL}?symbols=${batch.map(encodeURIComponent).join(',')}`);
    for (const q of parseQuotes(json)) out.set(q.symbol, q);
  }
  return out;
}

const SUMMARY_MODULES = 'price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings';

/**
 * quoteSummary for a `.T` symbol, cached per symbol by fetch time: a cached value younger than
 * `maxAgeMs` is returned without a request. Failures are not cached; an unknown symbol (404) is null.
 */
export function createYahooJpSummary(y: YahooClient): (symbol: string, maxAgeMs: number) => Promise<YahooForeignSummary | null> {
  const cache = new Map<string, { at: number; value: YahooForeignSummary | null }>();
  return async (symbol, maxAgeMs) => {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
    let value: YahooForeignSummary | null;
    try {
      value = parseYahooSummaryFor(
        await y.json(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${SUMMARY_MODULES}`),
        { zone: JST, capCurrency: 'JPY' },
      );
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      value = null;
    }
    cache.set(symbol, { at: Date.now(), value });
    return value;
  };
}

/**
 * The `earnings.financialsChart.quarterly` label for a quarter ending on `periodEnd`: the calendar
 * quarter containing the end date, e.g. 2026-09-30 → "3Q2026", 2025-11-30 → "4Q2025". Pinned by the
 * 7203.T, 3382.T and 9983.T fixtures. An unreadable date gives ''.
 */
export function jpRevenueQuarterLabel(periodEnd: string): string {
  const d = DateTime.fromISO(periodEnd, { zone: 'utc' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || !d.isValid) return '';
  return `${Math.ceil(d.month / 3)}Q${d.year}`;
}
