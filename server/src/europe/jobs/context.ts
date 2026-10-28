import type { DatabaseSync } from 'node:sqlite';
import { HttpError, SourceFormatError, type Http } from '../../sources/http.js';
import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import type { OptionChain } from '../../types.js';
import { figiCached, isinSearchCached, saveFigi, saveIsinSearch } from '../db/europeRepo.js';
import { EXCHANGES, exchangesOf, type EuropeMarket } from '../exchanges.js';
import type { createEsefClient } from '../sources/esef.js';
import type { FirdsShare } from '../sources/firds.js';
import type { FigiAnswer } from '../sources/openFigi.js';
import type { PrnItem } from '../sources/prnewswire.js';
import { parseSixList, type SixShare } from '../sources/sixList.js';
import type { EuropeCalRow, EuropeQuote } from '../sources/yahooEurope.js';
import { EU_FULL, UK_FULL } from '../universe.js';
import { EU_SYMBOL, UK_SYMBOL } from '../../watchlist/routes.js';
import { buildEuropeUniverse, figiJobsFor, leisFor, searchIsinsFor, type EuropeUniverseEntry } from '../universeBuild.js';

export { guardedIn, trackIn } from '../../india/jobs/context.js';

/**
 * What the UK / EU jobs need, one context per market. `index.ts` builds it (Task 19); tests stub it. Every Yahoo call
 * goes through the one shared `YahooClient` (≤ 1 request/s for the whole process).
 */
export interface EuropeJobContext {
  db: DatabaseSync;
  market: EuropeMarket;
  now(): string;                               // ISO UTC instant
  today(): string;                             // YYYY-MM-DD in Europe/London (UK) or Europe/Paris (EU)
  /** Bulk earnings calendar for one Yahoo region, dates `from`..`to`; `complete` is false when a page failed. */
  yahooCalendar(region: string, from: string, to: string): Promise<{ rows: EuropeCalRow[]; complete: boolean }>;
  /** One quoteSummary per symbol, served from cache when younger than `maxAgeMs`. */
  yahooSummary(symbol: string, maxAgeMs: number): Promise<YahooForeignSummary | null>;
  /** Batch quotes (50 symbols per request), keyed by Yahoo symbol; unquoted symbols are absent. */
  yahooQuotes(symbols: string[]): Promise<Map<string, EuropeQuote>>;
  /** Daily closes keyed by local date, `from`..`to` inclusive. */
  yahooCloses(symbol: string, from: string, to: string): Promise<Map<string, number>>;
  /**
   * This market's universe (`buildEuropeUniverseFor`). `complete` is false when a FIRDS part or the SIX list failed,
   * or one of this market's OpenFIGI jobs or Yahoo ISIN searches failed: the caller must not sync on it.
   */
  buildUniverse(): Promise<{ entries: EuropeUniverseEntry[]; leftOut: number; complete: boolean }>;
  /** gov.uk bank-holidays.json, parsed JSON. UK only; EU never calls it. */
  bankHolidaysJson(): Promise<unknown>;
  esef: ReturnType<typeof createEsefClient>;
  /** This market's PRN_FEEDS, merged, de-duplicated by link. */
  prnFeed(): Promise<PrnItem[]>;
  /**
   * DILA AMF day directory (file names) and one archive as a byte stream (the fetch body: a results-season batch is
   * 200-660 MB of gzip, so it is never buffered whole; read it with `parseDilaArchiveStream`). EU only; null for UK.
   */
  dila: { list(day: string): Promise<string[]>; archive(name: string): Promise<AsyncIterable<Uint8Array>> } | null;
  /** Cboe chain through the 15-minute cache (`cboeCache`) over the shared client. */
  optionChain(adr: string): Promise<OptionChain | null>;
  /** The one shared SEC client; null when SEC_USER_AGENT is not set (full-level SEC features off). */
  secHttp: Http | null;
  /** Visible ∪ watched symbols of this market. */
  tierA(): string[];
}

/** The fetchers behind a universe build (index.ts wires the real clients; tests stub them). */
export interface EuropeUniverseSources {
  /** `fetchFirdsShares` over the shared FIRDS client. */
  firds(source: 'esma' | 'fca', mics: ReadonlySet<string>, onShare: (s: FirdsShare) => void): Promise<{ files: number; complete: boolean }>;
  /** The SIX share list CSV text. */
  sixList(): Promise<string>;
  /** OpenFIGI mapping (`createOpenFigi(...).map`): a failed request's jobs come back `failed: true`. */
  figi(jobs: { isin: string; exchCode: string }[]): Promise<FigiAnswer[]>;
  /** `yahooIsinSearch`. */
  search(isin: string): Promise<string[]>;
  /** `fetchLegalNames` (a failed GLEIF batch only loses names; the FIRDS name is used instead). */
  names(leis: string[]): Promise<Map<string, string>>;
}

/** A cached OpenFIGI answer (or Yahoo ISIN search answer) is reused for this long; older ones are asked again. */
export const FIGI_CACHE_MAX_AGE_MS = 90 * 86_400_000;

/** Back-off before the 2nd and 3rd try of a failed Yahoo ISIN search (each try still waits on the shared limiter). */
export const SEARCH_RETRY_DELAYS_MS = [2_000, 10_000] as const;

/** A 429, a 5xx, a timeout or a network error: worth another try. A 404, other 4xx or a format error is not. */
export function transientFailure(err: unknown): boolean {
  if (err instanceof SourceFormatError) return false;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // yahooClient's network / timeout error ("Yahoo request failed (TimeoutError) for ..."), or any other thrown Error.
  return err instanceof Error && /request failed|timeout|network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(`${err.name} ${err.message}`);
}

/** `fn` with up to `delays.length` retries after a transient failure; the last failure is thrown. */
async function withRetry<T>(fn: () => Promise<T>, delays: readonly number[], sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !transientFailure(err)) throw err;
      await sleep(delays[attempt]!);
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/** The market an OpenFIGI exchCode belongs to (each code is one market's). */
const MARKET_OF_CODE: ReadonlyMap<string, EuropeMarket> = new Map(
  Object.values(EXCHANGES).flatMap((e) => Object.values(e.micExchCodes).map((c) => [c, e.market] as const)),
);

/**
 * One market's universe build (Rulings 4 and 5). Both markets are built from the same sources (the UK-first
 * tie-break needs every line), then `market`'s rows are returned. Completeness is judged per market:
 * - a FIRDS part or the SIX list failing changes the tie-break of both markets, so it makes both incomplete;
 * - a failed OpenFIGI job (`failed`, or no answer) makes only the market of its exchCode incomplete;
 * - a failed Yahoo ISIN search (after its retries) makes only the market of its line incomplete (STO / CPH: EU).
 * `buildEuropeUniverse` reads a failed OpenFIGI job as "no ticker", so an incomplete run would shrink the universe:
 * the caller never syncs it.
 * OpenFIGI answers are cached in `europe_figi` and ISIN search answers (a confirmed no-match too) in
 * `europe_isin_search`, both for 90 days; a failed request is never cached. A search that fails with a 429, a 5xx or
 * a timeout is tried again after 2 s and 10 s (`opts.sleep` in tests).
 */
export async function buildEuropeUniverseFor(
  db: DatabaseSync, market: EuropeMarket, src: EuropeUniverseSources, now: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ entries: EuropeUniverseEntry[]; leftOut: number; complete: boolean }> {
  const sleep = opts.sleep ?? defaultSleep;
  const complete: Record<EuropeMarket, boolean> = { UK: true, EU: true };
  const failed: Record<EuropeMarket, number> = { UK: 0, EU: 0 };
  const both = () => { complete.UK = false; complete.EU = false; };
  const fail = (m: EuropeMarket | undefined) => {
    if (!m) { both(); return; }
    complete[m] = false;
    failed[m]++;
  };
  const micsOf = (m: EuropeMarket) => new Set(exchangesOf(m).flatMap((id) => EXCHANGES[id].mics));
  const firdsUk: FirdsShare[] = [];
  const firdsEu: FirdsShare[] = [];
  for (const [source, m, out] of [['fca', 'UK', firdsUk], ['esma', 'EU', firdsEu]] as const) {
    try {
      const r = await src.firds(source, micsOf(m), (s) => out.push(s));
      if (!r.complete) both();
    } catch (err) {
      console.warn(`europe universe: FIRDS ${source} failed: ${(err as Error).message}`);
      both();
    }
  }
  let six: SixShare[] = [];
  try {
    six = parseSixList(await src.sixList());
  } catch (err) {
    console.warn(`europe universe: SIX list failed: ${(err as Error).message}`);
    both();
  }
  const base = { firdsUk, firdsEu, six };

  const nowMs = Date.parse(now);
  const fresh = (checkedAt: string) => nowMs - Date.parse(checkedAt) < FIGI_CACHE_MAX_AGE_MS;
  const figi: FigiAnswer[] = [];
  const ask: { isin: string; exchCode: string }[] = [];
  for (const job of figiJobsFor(base)) {
    const hit = figiCached(db, job.isin, job.exchCode);
    if (hit && fresh(hit.checkedAt)) figi.push({ ...job, tickers: hit.tickers });
    else ask.push(job);
  }
  if (ask.length > 0) {
    let answers: FigiAnswer[];
    try {
      answers = await src.figi(ask);
    } catch (err) {
      console.warn(`europe universe: OpenFIGI failed: ${(err as Error).message}`);
      answers = ask.map((j) => ({ ...j, tickers: [], failed: true as const }));
    }
    for (const a of answers) if (a.failed) fail(MARKET_OF_CODE.get(a.exchCode));
    const answered = new Set(answers.map((a) => `${a.isin}|${a.exchCode}`));
    for (const j of ask) if (!answered.has(`${j.isin}|${j.exchCode}`)) fail(MARKET_OF_CODE.get(j.exchCode));
    for (const a of answers) {
      if (!a.failed) saveFigi(db, { isin: a.isin, exchCode: a.exchCode, tickers: a.tickers, outcome: a.tickers.length > 0 ? 'tickers' : 'no-ticker' }, now);
    }
    figi.push(...answers);
  }

  const searchMarket = new Map<string, EuropeMarket | undefined>();
  for (const a of figi) if (!searchMarket.has(a.isin) || a.tickers.length > 0) searchMarket.set(a.isin, MARKET_OF_CODE.get(a.exchCode));
  const searched = new Map<string, string[]>();
  for (const isin of searchIsinsFor(figi)) {
    const hit = isinSearchCached(db, isin);
    if (hit && fresh(hit.checkedAt)) {
      searched.set(isin, hit.symbols);
      continue;
    }
    try {
      const symbols = await withRetry(() => src.search(isin), SEARCH_RETRY_DELAYS_MS, sleep);
      searched.set(isin, symbols);
      saveIsinSearch(db, isin, symbols, now);
    } catch (err) {
      console.warn(`europe universe: Yahoo ISIN search ${isin} failed: ${(err as Error).message}`);
      fail(searchMarket.get(isin));
    }
  }
  for (const m of ['UK', 'EU'] as const) {
    if (failed[m] > 0) console.warn(`europe universe: ${failed[m]} ${m} lookups failed; the ${m} build is incomplete`);
  }

  let names = new Map<string, string>();
  try {
    names = await src.names(leisFor(base));
  } catch (err) {
    console.warn(`europe universe: GLEIF failed, FIRDS names used: ${(err as Error).message}`);
  }

  const built = buildEuropeUniverse({ ...base, names, figi, searched, full: [...UK_FULL, ...EU_FULL] });
  // A left-out ISIN counts for one market only: UK when it has a live (issuer-requested, not terminated) UK line, as
  // the UK-first tie-break would place it, else EU. A dead UK line never pulls an EU ISIN to UK.
  const ukIsins = new Set(firdsUk.filter((s) => s.issuerRequested && !s.terminated).map((s) => s.isin));
  const leftOut = built.leftOut.filter((l) => (ukIsins.has(l.isin) ? 'UK' : 'EU') === market).length;
  // Every stored symbol must pass the format the API and watchlists accept (a ticker with '&' or over 15 characters
  // would otherwise be unwatchable and could not be sent as visible): one that fails is left out and counted.
  const format = market === 'UK' ? UK_SYMBOL : EU_SYMBOL;
  const all = market === 'UK' ? built.uk : built.eu;
  const entries = all.filter((e) => format.test(e.symbol));
  const badFormat = all.length - entries.length;
  if (badFormat > 0) console.warn(`europe universe: ${badFormat} ${market} symbol(s) off the symbol format left out`);
  return { entries, leftOut: leftOut + badFormat, complete: complete[market] };
}
