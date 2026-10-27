import { DateTime } from 'luxon';
import { BROWSER_UA, HttpError } from '../../sources/http.js';
import { openYahooSession } from '../../sources/yahooEarnings.js';
import { timingFromIst } from '../domain/nseCalendar.js';

export interface YahooPastDate { date: string; timing: 'BMO' | 'AMC' | 'DMH' | null }

export type TimingOf = (hhmm: string) => 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';

const IST = 'Asia/Kolkata';
const URL_BASE = 'https://query1.finance.yahoo.com/v1/finance/visualization';

/**
 * Rows of Yahoo's earnings "visualization" answer: [ticker, startdatetime (UTC ISO), startdatetimetype].
 * Only TAS rows ("time as supplied") carry a real clock time; the others are date-only estimates and are
 * ignored. The instant is converted to `zone` for the date and, through `timingOf`, for the timing.
 */
export function parseYahooPastDatesIn(json: unknown, zone: string, timingOf: TimingOf): YahooPastDate[] {
  const result = (json as { finance?: { result?: { documents?: { rows?: unknown[] }[] }[] | null } })?.finance?.result;
  const rows = result?.[0]?.documents?.[0]?.rows;
  if (!Array.isArray(rows)) return [];
  const out: YahooPastDate[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row[2] !== 'TAS' || typeof row[1] !== 'string') continue;
    const local = DateTime.fromISO(row[1], { zone: 'utc' }).setZone(zone);
    if (!local.isValid) continue;
    const timing = timingOf(local.toFormat('HH:mm'));
    out.push({ date: local.toISODate()!, timing: timing === 'UNKNOWN' ? null : timing });
  }
  return out;
}

export function parseYahooPastDates(json: unknown): YahooPastDate[] {
  return parseYahooPastDatesIn(json, IST, timingFromIst);
}

export interface YahooPastDatesDeps {
  session?: () => Promise<{ headers: Record<string, string>; crumb: string }>;
  fetchImpl?: typeof fetch;
}

let cached: { headers: Record<string, string>; crumb: string } | null = null;
let nextSlot = 0;

/** Past result dates (newest first) of a Yahoo symbol. Throws on HTTP errors so callers can record them. */
export async function fetchYahooPastDatesFor(
  yahooSymbol: string, zone: string, timingOf: TimingOf, deps: YahooPastDatesDeps = {},
): Promise<YahooPastDate[]> {
  const open = deps.session ?? (async () => (cached ??= await openYahooSession()));
  const doFetch = deps.fetchImpl ?? fetch;
  const body = JSON.stringify({
    size: 25, offset: 0, sortField: 'startdatetime', sortType: 'DESC', entityIdType: 'earnings',
    includeFields: ['ticker', 'startdatetime', 'startdatetimetype'],
    query: { operator: 'eq', operands: ['ticker', yahooSymbol] },
  });
  for (let attempt = 0; ; attempt++) {
    if (!deps.fetchImpl) { // one request a second, like the other Yahoo calls
      const slot = Math.max(Date.now(), nextSlot);
      nextSlot = slot + 1000;
      if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    }
    const session = await open();
    const res = await doFetch(`${URL_BASE}?crumb=${encodeURIComponent(session.crumb)}`, {
      method: 'POST',
      headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', ...session.headers },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return parseYahooPastDatesIn(await res.json(), zone, timingOf);
    if ((res.status === 401 || res.status === 403) && attempt === 0 && !deps.session) { cached = null; continue; }
    throw new HttpError(res.status, URL_BASE);
  }
}

/** Past result dates (newest first) of an NSE stock from Yahoo. */
export function fetchYahooPastDates(nseSymbol: string, deps: YahooPastDatesDeps = {}): Promise<YahooPastDate[]> {
  return fetchYahooPastDatesFor(`${nseSymbol}.NS`, IST, timingFromIst, deps);
}
