import type { DatabaseSync } from 'node:sqlite';
import type { Http } from '../../sources/http.js';
import type { YahooForeignSummary } from '../../sources/yahooForeignSummary.js';
import type { OptionChain } from '../../types.js';
import type { EdinetClient } from '../sources/edinet.js';
import type { YahooCalRow, YahooQuote } from '../sources/yahooJp.js';

export { guardedIn, trackIn } from '../../india/jobs/context.js';

/**
 * What the Japan jobs need. `index.ts` builds it (Task 13); tests stub it. Every Yahoo call goes through the one
 * Japan `YahooClient` (one session, at most 1 request/s overall).
 */
export interface JpJobContext {
  db: DatabaseSync;
  now(): string;                               // ISO UTC instant
  todayJST(): string;                          // YYYY-MM-DD in Asia/Tokyo
  /** Bulk earnings calendar for `.T` symbols, dates `from`..`to`; `complete` is false when a page failed. */
  yahooCalendar(from: string, to: string): Promise<{ rows: YahooCalRow[]; complete: boolean }>;
  /** One quoteSummary per `.T` symbol, served from cache when younger than `maxAgeMs`. */
  yahooSummary(symbol: string, maxAgeMs: number): Promise<YahooForeignSummary | null>;
  /** Batch quotes (50 symbols per request), keyed by Yahoo symbol; unquoted symbols are absent. */
  yahooQuotes(symbols: string[]): Promise<Map<string, YahooQuote>>;
  /** Daily closes keyed by JST date, `from`..`to` inclusive. */
  yahooCloses(symbol: string, from: string, to: string): Promise<Map<string, number>>;
  /** The decoded EDINET code list CSV (EdinetcodeDlInfo.csv). */
  edinetCodeList(): Promise<string>;
  /** Null without EDINET_API_KEY (EDINET off). */
  edinet: EdinetClient | null;
  optionChain(adr: string): Promise<OptionChain | null>;
  /** The one shared SEC client; null when SEC_USER_AGENT is not set (full-level SEC features off). */
  secHttp: Http | null;
  /** Visible ∪ watched JP codes. */
  tierA(): string[];
}
