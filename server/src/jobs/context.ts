import type { Db } from '../db/repo.js';
import { recordSourceError, recordSourceSuccess } from '../db/repo.js';
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
  investing?(tab: 'today' | 'yesterday', date: string): Promise<InvestingRow[]>;
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
