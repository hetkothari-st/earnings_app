import type { SecCheck, Timing, TimingSource } from './api/types.js';
export type { SecCheck, Timing, TimingSource } from './api/types.js';
/** How the previous report's timing was known: stored, inferred from the SEC filing time, or assumed from this quarter. */
export type PrevMoveBasis = 'known' | 'sec-inferred' | 'assumed';

/** One row of the Nasdaq earnings calendar for one date. */
export interface CalendarRow {
  symbol: string;
  name: string;
  reportDate: string;        // YYYY-MM-DD
  fiscalQuarter: string;     // e.g. "Sep/2026", or "date:<reportDate>" when missing
  timing: Timing;
  marketCap: number | null;
  epsEstimate: number | null;
  noOfEsts: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
  lastYearEps: number | null;
  lastYearReportDate: string | null; // YYYY-MM-DD
}

/** One Finnhub earnings-calendar item (revenue + timing hint). */
export interface RevenueRow {
  symbol: string;
  reportDate: string;
  timing: Timing;
  revenueEstimate: number | null;
  revenueActual: number | null;
  epsActual: number | null;
}

/** One item scraped in real-time from Investing.com. */
export interface InvestingRow {
  symbol: string;
  name?: string | null;
  reportDate: string; // YYYY-MM-DD
  timing: Timing;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprisePct: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

export interface OptionQuote {
  expiry: string;            // YYYY-MM-DD
  type: 'C' | 'P';
  strike: number;
  bid: number;
  ask: number;
}

export interface OptionChain {
  underlying: number;        // regular-session close
  quotes: OptionQuote[];
  asOfDate?: string | null;  // date of the underlying's last regular trade (YYYY-MM-DD)
  totalVolume?: number;      // contracts traded across the standard chain that day
  quoteTime?: string | null; // ET wall clock of the quotes (YYYY-MM-DDTHH:mm:ss), from the feed
}

/** Intraday expected move, refreshed through the session from (delayed) quotes. */
export interface LiveMove {
  movePct: number;
  illiquid: boolean;
  quoteTime: string | null;
  fetchedAt: string;
}

export interface ExpectedMove {
  expiry: string;
  strike: number;
  callMid: number;
  putMid: number;
  underlying: number;
  movePct: number;           // rounded to 2 decimals
  illiquid: boolean;
  optionsVolume?: number | null; // contracts traded across the chain on the snapshot day
  provisional?: boolean;         // priced off a close earlier than the last one before the release
  quoteDate?: string | null;     // date of the close the quotes are from
}

/** An 8-K containing Item 2.02 (results of operations). */
export interface Filing {
  accession: string;         // e.g. 0001628280-26-065582
  form: '8-K' | '6-K';       // 6-K: foreign issuers' reports (no item codes)
  filingDate: string;        // YYYY-MM-DD
  docUrl: string;
  indexUrl: string;
}

export interface ReportRecord {
  id: number;
  symbol: string;
  symbolKey: string;
  name: string;
  fiscalQuarter: string;
  reportDate: string;
  rescheduledFrom: string | null;
  /** 'estimated' while the date comes from the Yahoo backup, not the Nasdaq calendar. */
  dateStatus: 'confirmed' | 'estimated';
  timing: Timing;
  timingSource: TimingSource;
  timingConflict: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  sharesOutstanding: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
  epsConflict: string | null;
  noOfEsts: number | null;
  lastYearEps: number | null;
  lastYearReportDate: string | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueCurrency: string | null; // null = USD
  exchange: string | null;
  secCheck: SecCheck | null;
  secAcceptedAt: string | null;   // ET wall clock, YYYY-MM-DDTHH:mm:ss
  secDocUrl: string | null;
  secIndexUrl: string | null;
  releasedAt: string | null;
  epsPrelim: number | null;
  epsPrelimBasis: 'adjusted' | 'gaap' | null;
  revenuePrelim: number | null;
  epsCorrected: boolean;
  revenueCorrected: boolean;
  calendarFetchedAt: string | null;
  revenueFetchedAt: string | null;
  secCheckedAt: string | null;
  expectedMove: (ExpectedMove & { snapshotAt: string }) | null;
  prevMovePct: number | null;     // stock reaction to the previous report, %
  prevMoveDate: string | null;    // that previous report's date
  prevMoveBasis: PrevMoveBasis | null;
  sector: string | null;
  industry: string | null;
  liveMove: LiveMove | null;
}
