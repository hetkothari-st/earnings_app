// Type-only module shared with the web app. No runtime code here.
import type { BeatMiss } from '../../api/types.js';
import type { JpTiming } from '../domain/jpCalendar.js';

export type { JpTiming };

/** One side (EPS or revenue) of a report. Currencies are ISO codes as stated; never converted. */
export interface JpFigureDto {
  estimate: number | null;
  analysts: number | null;
  estimateCurrency: string | null;
  /** The estimate covers the quarter or the full fiscal year. */
  estimateSpan: 'quarter' | 'year' | null;
  /** For EPS: basic EPS per share. */
  actual: number | null;
  actualCurrency: string | null;
  actualSource: 'sec' | 'edinet' | 'yahoo' | null;
  /** A standalone quarter, or a year-to-date figure ("YTD (n months)"). */
  actualSpan: 'quarter' | 'ytd' | null;
  ytdMonths: 6 | 9 | 12 | null;
  /**
   * Non-null only when estimate and actual share a currency and a span (quarter vs quarter, or a 12-month YTD
   * actual vs a year estimate), and, for EPS, the actual is not from SEC.
   */
  surprisePct: number | null;
  result: BeatMiss | null;
}

/** One Japan report. Prices and market cap in JPY; figures in the currency stated by the source. */
export interface JpReportDto {
  id: number;
  market: 'JP';
  /** TSE code, 4 characters (e.g. "7203", "285A"). */
  symbol: string;
  name: string;
  nameJa: string | null;
  level: 'full' | 'basic';
  adrTicker: string | null;
  /** Tokyo shares per ADS (may be fractional). */
  adrRatio: number | null;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  /** Period label, e.g. "2Q FY27", "FY27". */
  period: string;
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
  timing: JpTiming;
  timingSource: 'sec-6k' | 'sec-notice' | 'yahoo' | null;
  releasedAt: string | null;
  rescheduledFrom: string | null;
  sector: string | null;
  industry: string | null;
  /** Japanese industry from the EDINET code list (提出者業種), shown as is. */
  industryJa: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  secDocUrl: string | null;
  edinetDocId: string | null;
  eps: JpFigureDto;
  /** Diluted EPS per share, same source and span as `eps.actual`; never coloured. */
  epsDiluted: number | null;
  revenue: JpFigureDto;
  /** ADR straddle; `underlying` is the US$ ADR close. */
  expectedMove: {
    adr: string; expiry: string; strike: number; callMid: number; putMid: number; underlying: number;
    movePct: number; illiquid: boolean; final: boolean; quoteDate: string; snapshotAt: string;
  } | null;
  liveMove: { movePct: number; changePp: number | null; illiquid: boolean; quoteTime: string | null } | null;
  previousMove: { pct: number; reportDate: string; basis: 'known' | 'assumed' } | null;
}

export interface JpEarningsResponse {
  rows: JpReportDto[];
}

export interface JpLivePriceDto { price: number; prevClose: number | null; changePct: number | null; at: string }

export interface JpMarketDto { index: string; price: number | null; changePct: number | null; asOf: string | null }

export interface JpAdminDto {
  full: number;
  basic: number;
  secConfigured: boolean;
  edinetConfigured: boolean;
  readerOn: boolean;
  lastSixKAt: string | null;
  lastEdinetAt: string | null;
}
