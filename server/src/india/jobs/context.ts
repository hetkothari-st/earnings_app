import type { DatabaseSync } from 'node:sqlite';
import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import type { Http } from '../../sources/http.js';
import type { KiteApi } from '../sources/kiteApi.js';
import type { KiteSession } from '../sources/kiteLogin.js';
import type { YahooInSummary } from '../sources/yahooIn.js';

export interface InJobContext {
  db: DatabaseSync;
  http: Http;                                  // NSE archives + Kite instrument dumps (public)
  kite: KiteApi;                               // authenticated Kite REST
  kiteSession: () => KiteSession | null;
  yahoo: (nseSymbol: string) => Promise<YahooInSummary | null>;
  now(): string;                               // ISO UTC instant
  todayIST(): string;                          // YYYY-MM-DD in Asia/Kolkata
}

/** Runs one India source call; records success/error; never throws. */
export async function trackIn<T>(ctx: InJobContext, source: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    recordSourceSuccess(ctx.db, source, ctx.now());
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSourceError(ctx.db, source, message, ctx.now());
    console.error(`[${source}] ${message}`);
    return undefined;
  }
}
