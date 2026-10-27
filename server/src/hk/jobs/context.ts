import type { DatabaseSync } from 'node:sqlite';
import type { YahooPastDate } from '../../india/sources/yahooPastDates.js';
import type { Http } from '../../sources/http.js';
import type { OptionChain } from '../../types.js';
import type { YahooHkSummary } from '../sources/yahooHk.js';

export { guardedIn, trackIn } from '../../india/jobs/context.js';

/** What the HK jobs need. Task 10 builds it; tests stub it. */
export interface HkJobContext {
  db: DatabaseSync;
  now(): string;                               // ISO UTC instant
  todayHKT(): string;                          // YYYY-MM-DD in Asia/Hong_Kong
  /** One summary per `.HK` symbol per 25 min (cached by the fetcher). */
  yahoo: (yahooSymbol: string) => Promise<YahooHkSummary | null>;
  /** Past result dates (newest first) with times where Yahoo has them. */
  yahooPastDates: (yahooSymbol: string) => Promise<YahooPastDate[]>;
  /** Daily closes keyed by HKT date, `from`..`to` inclusive. */
  yahooCloses: (yahooSymbol: string, from: string, to: string) => Promise<Map<string, number>>;
  optionChain: (adr: string) => Promise<OptionChain | null>;
  /** The one shared SEC client; null when SEC_USER_AGENT is not set (full-level SEC features off). */
  secHttp: Http | null;
}
