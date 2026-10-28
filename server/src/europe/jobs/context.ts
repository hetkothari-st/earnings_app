import type { DatabaseSync } from 'node:sqlite';
import type { Http } from '../../sources/http.js';
import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import type { OptionChain } from '../../types.js';
import { figiCached, saveFigi } from '../db/europeRepo.js';
import { EXCHANGES, exchangesOf, type EuropeMarket } from '../exchanges.js';
import type { createEsefClient } from '../sources/esef.js';
import type { FirdsShare } from '../sources/firds.js';
import { figiRunComplete, type FigiAnswer } from '../sources/openFigi.js';
import type { PrnItem } from '../sources/prnewswire.js';
import { parseSixList, type SixShare } from '../sources/sixList.js';
import type { EuropeCalRow, EuropeQuote } from '../sources/yahooEurope.js';
import { EU_FULL, UK_FULL } from '../universe.js';
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
   * This market's universe (`buildEuropeUniverseFor`). `complete` is false when any FIRDS part, the SIX list, an
   * OpenFIGI request or a Yahoo ISIN search failed: the caller must not sync on it.
   */
  buildUniverse(): Promise<{ entries: EuropeUniverseEntry[]; leftOut: number; complete: boolean }>;
  /** gov.uk bank-holidays.json, parsed JSON. UK only; EU never calls it. */
  bankHolidaysJson(): Promise<unknown>;
  esef: ReturnType<typeof createEsefClient>;
  /** This market's PRN_FEEDS, merged, de-duplicated by link. */
  prnFeed(): Promise<PrnItem[]>;
  /** DILA AMF day directory (file names) and one archive. EU only; null for UK. */
  dila: { list(day: string): Promise<string[]>; archive(name: string): Promise<Uint8Array> } | null;
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

/** A cached OpenFIGI answer is reused for this long; older ones are asked again (tickers change). */
export const FIGI_CACHE_MAX_AGE_MS = 90 * 86_400_000;

/**
 * One market's universe build (Rulings 4 and 5). Both markets are built from the same sources (the UK-first
 * tie-break needs every line), then `market`'s rows are returned. `complete` is true only when every FIRDS part was
 * read, the SIX list parsed, every OpenFIGI request answered (`figiRunComplete`) and every ISIN search answered:
 * `buildEuropeUniverse` reads a failed OpenFIGI job as "no ticker", so an incomplete run would shrink the universe.
 * OpenFIGI answers are cached in `europe_figi`; a failed job is never cached.
 */
export async function buildEuropeUniverseFor(
  db: DatabaseSync, market: EuropeMarket, src: EuropeUniverseSources, now: string,
): Promise<{ entries: EuropeUniverseEntry[]; leftOut: number; complete: boolean }> {
  let complete = true;
  const micsOf = (m: EuropeMarket) => new Set(exchangesOf(m).flatMap((id) => EXCHANGES[id].mics));
  const firdsUk: FirdsShare[] = [];
  const firdsEu: FirdsShare[] = [];
  for (const [source, m, out] of [['fca', 'UK', firdsUk], ['esma', 'EU', firdsEu]] as const) {
    try {
      const r = await src.firds(source, micsOf(m), (s) => out.push(s));
      if (!r.complete) complete = false;
    } catch (err) {
      console.warn(`europe universe: FIRDS ${source} failed: ${(err as Error).message}`);
      complete = false;
    }
  }
  let six: SixShare[] = [];
  try {
    six = parseSixList(await src.sixList());
  } catch (err) {
    console.warn(`europe universe: SIX list failed: ${(err as Error).message}`);
    complete = false;
  }
  const base = { firdsUk, firdsEu, six };

  const nowMs = Date.parse(now);
  const figi: FigiAnswer[] = [];
  const ask: { isin: string; exchCode: string }[] = [];
  for (const job of figiJobsFor(base)) {
    const hit = figiCached(db, job.isin, job.exchCode);
    if (hit && nowMs - Date.parse(hit.checkedAt) < FIGI_CACHE_MAX_AGE_MS) figi.push({ ...job, tickers: hit.tickers });
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
    if (!figiRunComplete(answers)) complete = false;
    const answered = new Set(answers.map((a) => `${a.isin}|${a.exchCode}`));
    if (ask.some((j) => !answered.has(`${j.isin}|${j.exchCode}`))) complete = false;
    for (const a of answers) {
      if (!a.failed) saveFigi(db, { isin: a.isin, exchCode: a.exchCode, tickers: a.tickers, outcome: a.tickers.length > 0 ? 'tickers' : 'no-ticker' }, now);
    }
    figi.push(...answers);
  }

  const searched = new Map<string, string[]>();
  for (const isin of searchIsinsFor(figi)) {
    try {
      searched.set(isin, await src.search(isin));
    } catch (err) {
      console.warn(`europe universe: Yahoo ISIN search ${isin} failed: ${(err as Error).message}`);
      complete = false;
    }
  }

  let names = new Map<string, string>();
  try {
    names = await src.names(leisFor(base));
  } catch (err) {
    console.warn(`europe universe: GLEIF failed, FIRDS names used: ${(err as Error).message}`);
  }

  const built = buildEuropeUniverse({ ...base, names, figi, searched, full: [...UK_FULL, ...EU_FULL] });
  const ukIsins = new Set(firdsUk.map((s) => s.isin));
  const leftOut = built.leftOut.filter((l) => (ukIsins.has(l.isin) ? 'UK' : 'EU') === market).length;
  return { entries: market === 'UK' ? built.uk : built.eu, leftOut, complete };
}
