import type { SecCheck, Timing, TimingSource } from './api/types.js';
export type { SecCheck, Timing, TimingSource } from './api/types.js';

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
}

/** An 8-K containing Item 2.02 (results of operations). */
export interface Filing {
  accession: string;         // e.g. 0001628280-26-065582
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
  timing: Timing;
  timingSource: TimingSource;
  timingConflict: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
  epsConflict: string | null;
  noOfEsts: number | null;
  lastYearEps: number | null;
  lastYearReportDate: string | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  exchange: string | null;
  secCheck: SecCheck | null;
  secAcceptedAt: string | null;   // ET wall clock, YYYY-MM-DDTHH:mm:ss
  secDocUrl: string | null;
  secIndexUrl: string | null;
  calendarFetchedAt: string | null;
  revenueFetchedAt: string | null;
  secCheckedAt: string | null;
  expectedMove: (ExpectedMove & { snapshotAt: string }) | null;
  prevMovePct: number | null;     // stock reaction to the previous report, %
  prevMoveDate: string | null;    // that previous report's date
}
