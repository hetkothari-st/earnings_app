// Type-only module shared with the web app. No runtime code here.
import type { BeatMiss } from '../../api/types.js';
import type { HkTiming } from '../domain/hkCalendar.js';
import type { HkPeriodKind } from '../domain/period.js';

export type { HkTiming, HkPeriodKind };

/** One side (EPS or revenue) of a report. Currencies are ISO codes as stated; never converted. */
export interface HkFigureDto {
  estimate: number | null;
  analysts: number | null;
  estimateCurrency: string | null;
  actual: number | null;
  actualCurrency: string | null;
  /** Non-null only when estimate and actual share a currency (and, for EPS, a per-share basis). */
  surprisePct: number | null;
  result: BeatMiss | null;
}

/** One Hong Kong report. Prices and market cap in HKD; figures in the currency stated by the source. */
export interface HkReportDto {
  id: number;
  market: 'HK';
  /** HK stock code, 4 digits. */
  symbol: string;
  name: string;
  level: 'full' | 'basic';
  adrTicker: string | null;
  adrRatio: number | null;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  /** Period label, e.g. "Q3 26", "1H26", "FY26". */
  period: string;
  periodEnd: string;
  periodKind: HkPeriodKind;
  timing: HkTiming;
  timingSource: 'sec-6k' | 'sec-8k' | 'sec-notice' | 'yahoo' | null;
  releasedAt: string | null;
  rescheduledFrom: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  /** Actual currency, else the estimate currency. */
  currency: string | null;
  epsBasis: 'share' | 'ads' | null;
  actualSource: 'sec' | 'yahoo' | null;
  secDocUrl: string | null;
  eps: HkFigureDto;
  revenue: HkFigureDto;
  /** ADR straddle; `underlying` is the US$ ADR close. */
  expectedMove: {
    adr: string; expiry: string; strike: number; callMid: number; putMid: number; underlying: number;
    movePct: number; illiquid: boolean; final: boolean; quoteDate: string; snapshotAt: string;
  } | null;
  liveMove: { movePct: number; changePp: number | null; illiquid: boolean; quoteTime: string | null } | null;
  previousMove: { pct: number; reportDate: string; basis: 'known' | 'assumed' } | null;
}

export interface HkEarningsResponse {
  rows: HkReportDto[];
}

export interface HkLivePriceDto { price: number; prevClose: number | null; changePct: number | null; at: string }

export interface HkMarketDto { index: string; price: number | null; changePct: number | null; asOf: string | null }

export interface HkAdminDto {
  full: number;
  basic: number;
  secConfigured: boolean;
  readerOn: boolean;
  lastSixKAt: string | null;
}
