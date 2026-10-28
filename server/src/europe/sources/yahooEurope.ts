/**
 * Yahoo Finance for UK and continental European listings. Every request goes through the one `YahooClient`
 * (one session, the shared limiter: at most 1 request/s for all Yahoo traffic).
 *
 * Live checks (2026-10-28), saved as fixtures in test/fixtures/europe/yahoo/:
 * - Bulk calendar: `POST /v1/finance/visualization` with `{ operator: 'eq', operands: ['region', R] }` works for all 14
 *   regions. Window 2026-10-20..2026-11-20 (fixtures `y_cal_<region>.json`, first page of 100): rows exist for
 *   gb 18, it 7, de 63, ch 2, se 1, dk 1 and for NO other region (fr, nl, be, pt, ie, no, fi, es answer total 0).
 *   A wider look (2025-01..2027-05) shows the empty ones are stale: newest row fr 2026-04-24 (3 rows in 2026),
 *   be 2026-05-13 (1), pt 2026-02-26 (2), no 2026-02-13 (3), nl 2025-11-22, ie 2025-05-23, fi 2025-10-28,
 *   es 2025-11-20 (none in 2026). Rule (Japan precedent): `bulkCalendar` is true only for a region whose fixture
 *   has a row dated 2026-01-01 or later (gb, it, de, ch, se, dk). The data is thin even there (gb 18 rows for a
 *   peak month), so the bulk calendar is a supplement; the per-symbol sweep stays the main date source.
 *   `startdatetimetype` mix: gb TAS 12 / TNS 6, it TAS 6 / TNS 1, de TAS 53 / TNS 10, ch TAS 2, se TNS 1, dk TNS 1.
 *   Region `gb` also returns `.IL` (LSE International) and `.XC` (Cboe UK) rows; `de` returns `.BE .DU .F .HA .MU
 *   .SG .HM` (other German venues) plus `.DE`; all of these are dropped (only our 14 suffixes are kept).
 *   Yahoo reads the date bounds as US Eastern dates, so the query asks one day more on each side and rows are cut
 *   to the window by their mapped date (as Japan). TNS rows carry a nominal `10:59Z` clock: the UTC date, UNKNOWN.
 * - Batch quote: `GET /v7/finance/quote?symbols=` (50 per call) works with the crumb. Unknown symbols are absent
 *   (of 50 asked, 46 came back: ZZZZ9.L and three symbols Yahoo does not carry were missing).
 *   `.L` lines quote `currency: "GBp"` (pence): AZN.L 12822 GBp. A `.L` line may quote another currency: IHG.L is
 *   `USD` (164.05). Other lines: `.DE .PA .AS .BR .LS .IR .MI .MC` EUR, `.ST` SEK, `.CO` DKK, `.SW` CHF, `.OL` NOK,
 *   `.HE` EUR. `financialCurrency` is the reporting currency and differs (AZN.L GBp / USD, VOD.L GBp / EUR).
 *   `marketCap` is in POUNDS for a GBp line, not pence: AZN.L 198.86bn = 12822p x ~1.55bn shares / 100 = GBP
 *   198.9bn (ULVR.L, BP.L, BARC.L agree), and in the quote currency elsewhere (NOVN.SW CHF 244.7bn at CHF 128.78;
 *   IHG.L USD 23.9bn at USD 164.05). The quote carries no cap-currency field. Rule (`europeCapCurrency`): GBp
 *   (and GBX) -> GBP, otherwise the price currency.
 * - Summaries (modules price, assetProfile, calendarEvents, earningsTrend, earningsHistory, earnings,
 *   defaultKeyStatistics): `defaultKeyStatistics.lastFiscalYearEnd.raw` is epoch seconds at 00:00 UTC of the fiscal
 *   year end (AZN.L, SAP.DE, NOVO-B.CO, FEVR.L 12; VOD.L, BT-A.L 3; GAW.L 5), present for every symbol tried. The
 *   month is read in UTC.
 *   `earningsTrend` is present for UK names but the EPS currency is the REPORTING currency, never pence: BT-A.L GBP
 *   0.0469, VOD.L EUR (0y 0.10146), AZN.L USD 2.585, GAW.L GBP. Revenue estimates are in the same currency. The
 *   `0q`/`+1q` entries are empty (endDate null) for half-year reporters and AIM/small names (VOD.L, GAW.L, FEVR.L
 *   have only `0y`/`+1y`), which `parseYahooSummaryFor` drops. `earningsHistory` is empty for BT-A.L (no actuals).
 *   `earnings.financialsChart.quarterly` labels are calendar quarters ("2Q2026"), absent for GAW.L.
 *   `calendarEvents.earnings.earningsDate` is a single date for most names; `isEarningsDateEstimate` was false on
 *   every name tried.
 * - Indices (chart endpoint, range 5d): all 11 answer. Currencies GBP (^FTSE ^FTMC ^FTAI), EUR (^STOXX50E ^GDAXI
 *   ^FCHI ^AEX ^IBEX FTSEMIB.MI), CHF (^SSMI), SEK (^OMX).
 * - ISIN search: `GET /v1/finance/search?q=<ISIN>&quotesCount=10&newsCount=0` -> `quotes[].symbol`; SE0000108656
 *   gives exactly ERIC-B.ST (EQUITY, STO) and GB0009895292 gives AZN.L.
 * - Exchange facts used here (sessions, zones) are the plan's Ruling 3; `ExchangeId` is declared here until
 *   `europe/exchanges.ts` (Task 1) lands, then it should be imported from there.
 */
import { DateTime } from 'luxon';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import { HttpError } from '../../sources/http.js';
import { parseYahooSummaryFor, type YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import type { YahooClient } from '../../sources/yahooClient.js';

export type ExchangeId =
  | 'LSE' | 'PAR' | 'AMS' | 'BRU' | 'LIS' | 'DUB' | 'MIL' | 'OSL' | 'XET' | 'SIX' | 'STO' | 'CPH' | 'HEL' | 'MAD';

/** Yahoo's visualization region per exchange, and whether its bulk calendar is current (see the live checks above). */
export const YAHOO_REGIONS: Readonly<Record<ExchangeId, { region: string; bulkCalendar: boolean }>> = {
  LSE: { region: 'gb', bulkCalendar: true },
  PAR: { region: 'fr', bulkCalendar: false },
  AMS: { region: 'nl', bulkCalendar: false },
  BRU: { region: 'be', bulkCalendar: false },
  LIS: { region: 'pt', bulkCalendar: false },
  DUB: { region: 'ie', bulkCalendar: false },
  MIL: { region: 'it', bulkCalendar: true },
  OSL: { region: 'no', bulkCalendar: false },
  XET: { region: 'de', bulkCalendar: true },
  SIX: { region: 'ch', bulkCalendar: true },
  STO: { region: 'se', bulkCalendar: true },
  CPH: { region: 'dk', bulkCalendar: true },
  HEL: { region: 'fi', bulkCalendar: false },
  MAD: { region: 'es', bulkCalendar: false },
};

/** Session per Yahoo suffix (local clock, Ruling 3): BMO < open, DMH open..close-1, AMC >= close. */
const SESSIONS: Readonly<Record<string, { openMin: number; closeMin: number }>> = {
  L: { openMin: 8 * 60, closeMin: 16 * 60 + 30 },
  PA: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  AS: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  BR: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  LS: { openMin: 8 * 60, closeMin: 16 * 60 + 30 },
  IR: { openMin: 8 * 60, closeMin: 16 * 60 + 30 },
  MI: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  OL: { openMin: 9 * 60, closeMin: 16 * 60 + 20 },
  DE: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  SW: { openMin: 9 * 60, closeMin: 17 * 60 + 20 },
  ST: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  CO: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
  HE: { openMin: 10 * 60, closeMin: 18 * 60 + 30 },
  MC: { openMin: 9 * 60, closeMin: 17 * 60 + 30 },
};

/** Zone per Yahoo suffix (Ruling 3); the default for `createYahooEuropeSummary` until `exchanges.ts` provides it. */
const SUFFIX_ZONES: Readonly<Record<string, string>> = {
  L: 'Europe/London', PA: 'Europe/Paris', AS: 'Europe/Amsterdam', BR: 'Europe/Brussels', LS: 'Europe/Lisbon',
  IR: 'Europe/Dublin', MI: 'Europe/Rome', OL: 'Europe/Oslo', DE: 'Europe/Berlin', SW: 'Europe/Zurich',
  ST: 'Europe/Stockholm', CO: 'Europe/Copenhagen', HE: 'Europe/Helsinki', MC: 'Europe/Madrid',
};

const suffixOf = (symbol: string): string | null => {
  const i = symbol.lastIndexOf('.');
  return i > 0 ? symbol.slice(i + 1).toUpperCase() : null;
};

/** True when the symbol ends in one of our 14 Yahoo suffixes. */
const isOurSymbol = (symbol: string): boolean => {
  const s = suffixOf(symbol);
  return s != null && s in SESSIONS;
};

/** The zone of a symbol's exchange from its Yahoo suffix; null for a suffix that is not ours. */
export function defaultZoneOf(symbol: string): string | null {
  return SUFFIX_ZONES[suffixOf(symbol) ?? ''] ?? null;
}

function timingAt(symbol: string, hhmm: string): LocalTiming {
  const sess = SESSIONS[suffixOf(symbol) ?? ''];
  if (!sess) return 'UNKNOWN';
  const [h, m] = hhmm.split(':').map(Number);
  const total = h! * 60 + m!;
  if (total < sess.openMin) return 'BMO';
  return total >= sess.closeMin ? 'AMC' : 'DMH';
}

export interface EuropeCalRow {
  /** Yahoo symbol, e.g. "AZN.L". */
  symbol: string;
  /** TAS rows: the local date in the symbol's exchange zone. Other rows: the UTC date of `startdatetime`. */
  date: string;
  /** TAS rows: from the local clock. Other rows: UNKNOWN. */
  timing: LocalTiming;
  /** Yahoo's `startdatetimetype` (TAS = time as supplied, TNS = time not supplied, ...). */
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

function toRow(row: unknown[], col: (id: string) => number, zoneOf: (symbol: string) => string | null): EuropeCalRow | null {
  const symbol = row[col('ticker')];
  const start = row[col('startdatetime')];
  const type = row[col('startdatetimetype')];
  if (typeof symbol !== 'string' || typeof start !== 'string' || typeof type !== 'string') return null;
  if (!isOurSymbol(symbol)) return null;
  const utc = DateTime.fromISO(start, { zone: 'utc' });
  if (!utc.isValid) return null;
  const eps = col('epsactual') >= 0 ? row[col('epsactual')] : null;
  const epsActual = typeof eps === 'number' && Number.isFinite(eps) ? eps : null;
  if (type === 'TAS') {
    const zone = zoneOf(symbol);
    const local = zone ? utc.setZone(zone) : null;
    if (local?.isValid) {
      return { symbol, date: local.toISODate()!, timing: timingAt(symbol, local.toFormat('HH:mm')), timeType: type, epsActual };
    }
  }
  return { symbol, date: utc.toISODate()!, timing: 'UNKNOWN', timeType: type, epsActual };
}

/** One page of the bulk calendar. Rows whose suffix is not one of our 14 are dropped. */
export function parseEuropeCalendarPage(
  json: unknown,
  zoneOf: (symbol: string) => string | null,
): { rows: EuropeCalRow[]; total: number | null } {
  const page = readPage(json);
  const ids = page.columns ?? INCLUDE_FIELDS;
  const col = (id: string) => ids.indexOf(id);
  return { rows: page.rows.flatMap((r) => toRow(r, col, zoneOf) ?? []), total: page.total };
}

const addDays = (d: string, n: number) => DateTime.fromISO(d, { zone: 'utc' }).plus({ days: n }).toISODate()!;

/**
 * Every earnings row Yahoo lists for `region` with a date in [from, to] (YYYY-MM-DD, both inclusive). Pages of 100
 * until `total` or an empty page, at most 80 pages. A failure mid-sweep returns the rows so far with
 * `complete: false`; so do a malformed page and reaching the page cap before the end.
 */
export async function fetchEuropeEarningsCalendar(
  y: YahooClient, region: string, from: string, to: string, zoneOf: (symbol: string) => string | null,
): Promise<{ rows: EuropeCalRow[]; complete: boolean }> {
  const rows: EuropeCalRow[] = [];
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
          { operator: 'eq', operands: ['region', region] },
        ] },
      });
    } catch {
      return { rows, complete: false };
    }
    const raw = readPage(json);
    // A 200 that is not a calendar page (an error body, a changed shape) is a failure, not the end of the list.
    if (!raw.wellFormed) return { rows, complete: false };
    const parsed = parseEuropeCalendarPage(json, zoneOf);
    rows.push(...parsed.rows.filter((r) => r.date >= from && r.date <= to));
    if (raw.rows.length === 0) return { rows, complete: true };
    if (raw.total != null ? offset + PAGE_SIZE >= raw.total : raw.rows.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * The currency Yahoo's `marketCap` is in, given the quote currency: pounds for a pence line (GBp, GBX), otherwise the
 * quote currency itself (checked on 50 symbols; see the header). An unknown quote currency gives null.
 */
export function europeCapCurrency(priceCurrency: string | null): string | null {
  if (!priceCurrency) return null;
  return priceCurrency === 'GBp' || priceCurrency === 'GBX' ? 'GBP' : priceCurrency;
}

export interface EuropeQuote {
  symbol: string;
  price: number | null;
  prevClose: number | null;
  /** Epoch milliseconds of the quote. */
  time: number | null;
  /** As Yahoo states it: "GBp" for pence, "GBP", "EUR", "USD", ... */
  currency: string | null;
  /** In `marketCapCurrency` (pounds for a pence line). */
  marketCap: number | null;
  marketCapCurrency: string | null;
  name: string | null;
}

const QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const QUOTE_BATCH = 50;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

function parseQuotes(json: unknown): EuropeQuote[] {
  const result = (json as { quoteResponse?: { result?: unknown } } | null)?.quoteResponse?.result;
  if (!Array.isArray(result)) return [];
  return result.flatMap((q: Record<string, unknown>) => {
    const symbol = str(q?.symbol);
    if (!symbol) return [];
    const currency = str(q.currency);
    const time = num(q.regularMarketTime);
    const cap = num(q.marketCap);
    const capCurrency = cap != null ? europeCapCurrency(currency) : null;
    return [{
      symbol,
      price: num(q.regularMarketPrice),
      prevClose: num(q.regularMarketPreviousClose),
      time: time != null ? time * 1000 : null,
      currency,
      marketCap: capCurrency != null ? cap : null,
      marketCapCurrency: capCurrency,
      name: str(q.longName) ?? str(q.shortName)?.trim() ?? null,
    }];
  });
}

/** Batch quotes, 50 symbols per request. Symbols Yahoo does not know are absent from the map. A failed batch throws. */
export async function fetchEuropeQuotes(y: YahooClient, symbols: string[]): Promise<Map<string, EuropeQuote>> {
  const out = new Map<string, EuropeQuote>();
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const batch = symbols.slice(i, i + QUOTE_BATCH);
    const json = await y.json(`${QUOTE_URL}?symbols=${batch.map(encodeURIComponent).join(',')}`);
    for (const q of parseQuotes(json)) out.set(q.symbol, q);
  }
  return out;
}

const SUMMARY_MODULES = 'price,assetProfile,calendarEvents,earningsTrend,earningsHistory,earnings,defaultKeyStatistics';

/** Parses a quoteSummary answer for a symbol listed in `zone`. The cap is kept with the currency it is in. */
export function parseEuropeSummary(json: unknown, zone: string): YahooForeignSummary {
  return parseYahooSummaryFor(json, { zone, capCurrency: europeCapCurrency });
}

/**
 * quoteSummary for a UK/EU symbol, cached per symbol by fetch time: a cached value younger than `maxAgeMs` is
 * returned without a request. Failures are not cached; an unknown symbol (404) is null. The zone is the symbol's
 * exchange (`zoneOf`, by default from its Yahoo suffix); a symbol with no known zone gets null without a request.
 */
export function createYahooEuropeSummary(
  y: YahooClient,
  zoneOf: (symbol: string) => string | null = defaultZoneOf,
): (symbol: string, maxAgeMs: number) => Promise<YahooForeignSummary | null> {
  const cache = new Map<string, { at: number; value: YahooForeignSummary | null }>();
  return async (symbol, maxAgeMs) => {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
    const zone = zoneOf(symbol);
    if (!zone) return null;
    let value: YahooForeignSummary | null;
    try {
      value = parseEuropeSummary(
        await y.json(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${SUMMARY_MODULES}`),
        zone,
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
 * The symbols Yahoo's search returns for an ISIN (equities only; a result with no quoteType is kept). An unknown
 * query gives []. Only a candidate in this list is accepted as the symbol of that ISIN.
 */
export async function yahooIsinSearch(y: YahooClient, isin: string): Promise<string[]> {
  const json = await y.json(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=10&newsCount=0`,
  );
  const quotes = (json as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes.flatMap((q: Record<string, unknown>) => {
    const symbol = str(q?.symbol);
    const type = str(q?.quoteType);
    return symbol && (type == null || type === 'EQUITY') ? [symbol] : [];
  });
}

export const EUROPE_INDICES: {
  UK: readonly { name: string; yahoo: string }[];
  EU: readonly { name: string; yahoo: string }[];
} = {
  UK: [
    { name: 'FTSE 100', yahoo: '^FTSE' },
    { name: 'FTSE 250', yahoo: '^FTMC' },
    { name: 'FTSE AIM All-Share', yahoo: '^FTAI' },
  ],
  EU: [
    { name: 'Euro Stoxx 50', yahoo: '^STOXX50E' },
    { name: 'DAX', yahoo: '^GDAXI' },
    { name: 'CAC 40', yahoo: '^FCHI' },
    { name: 'AEX', yahoo: '^AEX' },
    { name: 'IBEX 35', yahoo: '^IBEX' },
    { name: 'FTSE MIB', yahoo: 'FTSEMIB.MI' },
    { name: 'SMI', yahoo: '^SSMI' },
    { name: 'OMXS30', yahoo: '^OMX' },
  ],
};
