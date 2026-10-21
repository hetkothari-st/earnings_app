// Type-only module shared with the web app. No runtime code here.
import type { InReportDto } from '../india/api/types.js';
export type Timing = 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN';
export type TimingSource = 'nasdaq' | 'finnhub' | 'sec' | 'investing' | null;
export type SecCheck = 'verified' | 'consistent' | 'derived' | 'contradicted' | 'unverifiable';
export type BeatMiss = 'beat' | 'miss' | 'inline';

export interface Flag {
  field: 'timing' | 'marketCap' | 'eps' | 'expectedMove';
  message: string;
}

export interface ResultPart {
  estimate: number | null;
  actual: number | null;
  surprisePct: number | null;
  result: BeatMiss | null;
}

export interface ReportDto {
  id: number;
  symbol: string;
  name: string;
  reportDate: string;
  fiscalQuarter: string | null;
  timing: Timing;
  timingSource: TimingSource;
  sessionClose: '16:00' | '13:00';
  rescheduledFrom: string | null;
  dateStatus: 'confirmed' | 'estimated';
  releasedAt: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  /** Latest share count (SEC cover page); live market cap = live price x this. */
  sharesOutstanding: number | null;
  eps: ResultPart & { preliminary: boolean; corrected: boolean; basis: 'adjusted' | 'gaap' | null; noOfEsts: number | null; lastYear: number | null; lastYearReportDate: string | null };
  revenue: ResultPart & { preliminary: boolean; corrected: boolean; currency: string };
  expectedMove: {
    movePct: number;
    illiquid: boolean;
    expiry: string;
    strike: number;
    callMid: number;
    putMid: number;
    underlying: number;
    optionsVolume?: number | null;
    provisional?: boolean;
    quoteDate?: string | null;
    snapshotAt: string;
  } | null;
  /** Intraday expected move and its change in percentage points since the last-close value. */
  liveMove: { movePct: number; changePp: number | null; illiquid: boolean; quoteTime: string | null } | null;
  previousMove: { pct: number; reportDate: string; basis: 'known' | 'sec-inferred' | 'assumed' } | null;
  sec: { check: SecCheck | null; acceptedAt: string | null; docUrl: string | null; indexUrl: string | null };
  fetched: { calendar: string | null; revenue: string | null; sec: string | null };
  flags: Flag[];
}

export interface SourceStatusDto {
  source: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  state: 'ok' | 'failing' | 'blocked' | 'backup' | null;
  blockedUntil: string | null;
}

export interface EarningsResponse {
  rows: ReportDto[];
  sources: SourceStatusDto[];
}

export interface StatusResponse {
  sources: SourceStatusDto[];
  counts: { reports: number; withExpectedMove: number; secVerified: number };
}

export interface MarketIndexDto {
  exchange: string;
  index: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  asOf: string | null;
  currency: string | null;
}

export interface MarketsResponse {
  indices: MarketIndexDto[];
}

export interface SymbolEntry {
  symbol: string;
  name: string;
  exchange: string;
}
export interface SymbolsResponse { results: SymbolEntry[] }
export interface WatchlistResponse { symbols: string[] }
/** One watched symbol: its next upcoming report and its most recent past one (either may be missing). */
/** Past EPS from the Yahoo backup: no report date is known. */
export interface WatchHistoryDto {
  source: 'yahoo';
  reportDate: null;
  fiscalQuarter: string;
  periodEnd: string;
  eps: { actual: number };
}
export interface WatchRow {
  symbol: string;
  name: string;
  next: ReportDto | InReportDto | null;
  latest: ReportDto | InReportDto | WatchHistoryDto | null;
}
export interface WatchRowsResponse { rows: WatchRow[] }
