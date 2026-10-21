// Type-only module shared with the web app. No runtime code here.
import type { BeatMiss } from '../../api/types.js';

export type InTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';
export type Market = 'US' | 'IN';

/** One India (NSE F&O) report. Money in full rupees; EPS in rupees per share. */
export interface InReportDto {
  id: number;
  market: 'IN';
  symbol: string;
  name: string;
  reportDate: string;
  /** 'confirmed' = from an NSE filing; 'estimated' = Yahoo's date. */
  dateStatus: 'confirmed' | 'estimated';
  fiscalQuarter: string;              // e.g. "Sep/2026"
  quarterEnd: string;
  timing: InTiming;
  timingSource: 'nse-filing' | 'nse-announcement' | null;
  releasedAt: string | null;          // ISO instant results were made public
  rescheduledFrom: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  /** Latest share count (Yahoo); live market cap = live price x this. */
  sharesOutstanding: number | null;
  /** Basis of the figures shown (of the preliminary ones while any are shown). Beat/miss only for consolidated figures. */
  basis: 'consolidated' | 'standalone' | null;
  /**
   * `preliminary`: read from the results PDF, not yet confirmed by the XBRL filing.
   * `corrected`: the filing differed from the preliminary value and replaced it.
   */
  eps: {
    estimate: number | null; analysts: number | null; actual: number | null; surprisePct: number | null; result: BeatMiss | null;
    preliminary: boolean; corrected: boolean;
  };
  /** Banks file total income instead of revenue from operations (kind 'total-income'): no beat/miss for them. */
  revenue: {
    estimate: number | null; analysts: number | null; actual: number | null;
    kind: 'revenue-from-ops' | 'total-income' | null; surprisePct: number | null; result: BeatMiss | null;
    preliminary: boolean; corrected: boolean;
  };
  profit: { actual: number | null; preliminary: boolean; corrected: boolean };
  expectedMove: {
    expiry: string; strike: number; callMid: number; putMid: number; underlying: number;
    movePct: number; illiquid: boolean; final: boolean; snapshotAt: string;
  } | null;
  liveMove: { movePct: number; changePp: number | null; illiquid: boolean; quoteTime: string | null } | null;
  previousMove: { pct: number; reportDate: string; basis: 'known' | 'assumed' } | null;
}

export interface InEarningsResponse {
  rows: InReportDto[];
}

/** `source`: 'stream' = Kite ticker, 'backup' = Yahoo while the ticker is silent for that stock. */
export interface InLivePriceDto { price: number; prevClose: number | null; changePct: number | null; at: string; source: 'stream' | 'backup' }

export interface InMarketDto { index: string; price: number | null; changePct: number | null; asOf: string | null; source: 'kite' | 'yahoo' | null }

export interface KiteStatusDto {
  configured: boolean;
  connected: boolean;
  lastLoginAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
