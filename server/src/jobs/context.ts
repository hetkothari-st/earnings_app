import type { Db } from '../db/repo.js';
import { recordSourceError, recordSourceSuccess } from '../db/repo.js';
import { blockAware, failoverFor } from '../sources/failover.js';
import type { Http } from '../sources/http.js';
import type { PastEps } from '../sources/nasdaq.js';
import type { SecTicker } from '../sources/sec.js';
import type { YahooSummary } from '../sources/yahooEarnings.js';
import type { CalendarRow, Filing, InvestingRow, OptionChain, RevenueRow } from '../types.js';

/** Every external data source the jobs use. Paid sources later implement the same interface. */
export interface Sources {
  calendar(date: string): Promise<CalendarRow[]>;
  earningsDetails(from: string, to: string): Promise<RevenueRow[]>;
  optionChain(symbol: string): Promise<OptionChain | null>;
  secTickers(): Promise<Map<string, SecTicker>>;
  secEarningsFilings(cik: number): Promise<Filing[]>;
  secAcceptance(cik: number, accession: string): Promise<string>;
  dailyCloses(symbol: string, from: string, to: string): Promise<Map<string, number>>;
  sectors(): Promise<Map<string, { sector: string | null; industry: string | null }>>;
  yahooSummary(symbol: string): Promise<YahooSummary | null>;
  /** Past quarters' reported EPS (watched-stock backfill). */
  earningsSurprise?(symbol: string): Promise<PastEps[]>;
  investing?(tab: 'today' | 'yesterday', date: string): Promise<InvestingRow[]>;
  /** The one SEC client (<= 10 requests/s for the whole app); absent without SEC_USER_AGENT. */
  secHttp?: Http;
}

export interface JobContext {
  db: Db;
  sources: Sources;
  now(): string;   // ISO UTC instant
  today(): string; // YYYY-MM-DD in America/New_York
}

/** Runs one source call; records success/error in source_status; never throws. */
export async function track<T>(ctx: JobContext, source: string, fn: () => Promise<T>): Promise<T | undefined> {
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
 * A fast source call with its backup (null: keep the stored values). Blocks (403/429, a block page served
 * as 200) back the fast source off; success, failure and "on backup" are recorded in source_status.
 * Never throws; null when neither worked.
 */
export async function guarded<T>(
  ctx: JobContext, fast: { name: string; run: () => Promise<T> }, backup: { name: string; run: () => Promise<T> } | null = null,
): Promise<{ value: T; via: 'fast' | 'backup' } | null> {
  const failover = failoverFor(ctx, ctx.db, () => Date.parse(ctx.now()));
  const result = await failover({ name: fast.name, run: () => blockAware(fast.name, fast.run) }, backup);
  return result;
}
