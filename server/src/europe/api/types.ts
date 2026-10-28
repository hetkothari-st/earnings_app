// Type-only module shared with the web app. No runtime code here.
import type { BeatMiss } from '../../api/types.js';
import type { LocalTiming } from '../../domain/exchangeCalendar.js';
import type { ExchangeId } from '../exchanges.js';
import type { TradegateState } from '../sources/tradegate.js';

export type { ExchangeId, LocalTiming };

/** One side (EPS or revenue) of a report. Currencies as stated ('GBp' pence, 'GBP' pounds); never converted. */
export interface EuropeFigureDto {
  estimate: number | null;
  analysts: number | null;
  estimateCurrency: string | null;
  /** The estimate covers the quarter or the full fiscal year. */
  estimateSpan: 'quarter' | 'year' | null;
  /** For EPS: basic EPS per share. */
  actual: number | null;
  actualCurrency: string | null;
  actualSource: 'sec' | 'esef' | 'yahoo' | null;
  /** A standalone quarter, or a year-to-date figure ("YTD (n months)"). */
  actualSpan: 'quarter' | 'ytd' | null;
  ytdMonths: 6 | 9 | 12 | null;
  /**
   * Non-null only when estimate and actual share a currency string (GBp ≠ GBP) and a span (quarter vs quarter, or a
   * 12-month YTD actual vs a year estimate), and, for EPS, the actual is not from SEC.
   */
  surprisePct: number | null;
  result: BeatMiss | null;
}

/** One UK or Europe report. Figures in the currency stated by the source. */
export interface EuropeReportDto {
  id: number;
  market: 'UK' | 'EU';
  /** Yahoo symbol, e.g. "AZN.L", "SAP.DE". */
  symbol: string;
  isin: string | null;
  name: string;
  exchange: ExchangeId;
  exchangeName: string;
  country: string | null;
  level: 'full' | 'basic';
  adrTicker: string | null;
  /** Local shares per US share; shown only when verified against the SEC filing. */
  adrRatio: number | null;
  reportDate: string;
  dateStatus: 'confirmed' | 'estimated';
  /** Period label ("Q1 FY26", "H1 FY26", "FY26"); null until a source confirms the period (web: "Period not stated"). */
  period: string | null;
  periodEnd: string;
  fiscalQuarter: 1 | 2 | 3 | 4;
  fyEnd: string;
  timing: LocalTiming;
  timingSource: 'sec-notice' | 'prn' | 'yahoo' | null;
  releasedAt: string | null;
  releasedSource: 'sec' | 'prn' | 'dila' | 'yahoo' | null;
  /** The results-out signal's title and link (PR Newswire item, DILA document, SEC filing). */
  signal: { title: string; url: string } | null;
  rescheduledFrom: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  /** As Yahoo states it for the cap; never converted. */
  marketCapCurrency: string | null;
  marketCapAsOf: string | null;
  secDocUrl: string | null;
  esefUrl: string | null;
  eps: EuropeFigureDto;
  /** Diluted EPS per share, same source, unit and span as `eps.actual`; never coloured. */
  epsDiluted: number | null;
  revenue: EuropeFigureDto;
  /** ADR straddle (full level); `underlying` is the US$ ADR close. */
  expectedMove: {
    adr: string; expiry: string; strike: number; callMid: number; putMid: number; underlying: number;
    movePct: number; illiquid: boolean; final: boolean; quoteDate: string; snapshotAt: string;
  } | null;
  liveMove: { movePct: number; changePp: number | null; illiquid: boolean; quoteTime: string | null } | null;
  previousMove: { pct: number; reportDate: string; basis: 'known' | 'assumed' } | null;
}

export interface EuropeEarningsResponse {
  rows: EuropeReportDto[];
}

export interface EuropeLivePriceDto {
  price: number;
  prevClose: number | null;
  /** From the same venue's answer only: never Tradegate's price against Yahoo's close. */
  changePct: number | null;
  at: string;
  currency: string | null;
  venue: 'tradegate' | 'yahoo';
}

export interface EuropeMarketDto { index: string; price: number | null; changePct: number | null; asOf: string | null }

export interface EuropeMarketAdmin {
  full: number;
  basic: number;
  inactive: number;
  /** From the last universe build this process ran; null until one has run (unknown, never 0). */
  leftOut: number | null;
  lastUniverseAt: string | null;
  lastSixKAt: string | null;
  lastPrnAt: string | null;
  lastDilaAt: string | null;
  lastEsefAt: string | null;
  readerOn: boolean;
}

export interface EuropeAdminDto {
  UK: EuropeMarketAdmin;
  EU: EuropeMarketAdmin;
  /** `state` null: no live Tradegate client to ask (unknown). */
  tradegate: { state: TradegateState | null; backoffUntil: string | null; lastPollAt: string | null };
  secConfigured: boolean;
  openFigiConfigured: boolean;
}
