import type { DatabaseSync } from 'node:sqlite';
import { recordSourceError, recordSourceSuccess } from '../../db/repo.js';
import { blockAware, failoverFor } from '../../sources/failover.js';
import type { Http } from '../../sources/http.js';
import type { KiteApi } from '../sources/kiteApi.js';
import type { KiteSession } from '../sources/kiteLogin.js';
import type { YahooInSummary } from '../sources/yahooIn.js';
import type { YahooPastDate } from '../sources/yahooPastDates.js';

export interface InJobContext {
  db: DatabaseSync;
  http: Http;                                  // NSE archives + Kite instrument dumps (public)
  kite: KiteApi;                               // authenticated Kite REST
  kiteSession: () => KiteSession | null;
  yahoo: (nseSymbol: string) => Promise<YahooInSummary | null>;
  /** Past result dates (newest first) with times; backup for a stock's previous report. */
  yahooPastDates?: (nseSymbol: string) => Promise<YahooPastDate[]>;
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

/**
 * A fast India source call with its backup (null: keep the stored values). A refusal (403/429, an HTML
 * page instead of the feed) backs the fast source off. Never throws; null when neither worked.
 */
export async function guardedIn<T>(
  ctx: InJobContext, fast: { name: string; run: () => Promise<T> }, backup: { name: string; run: () => Promise<T> } | null = null,
): Promise<{ value: T; via: 'fast' | 'backup' } | null> {
  const failover = failoverFor(ctx, ctx.db, () => Date.parse(ctx.now()));
  return failover({ name: fast.name, run: () => blockAware(fast.name, fast.run) }, backup);
}
