// Type-only module shared with the web app. No runtime code here.
export type Timing = 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN';
export type TimingSource = 'nasdaq' | 'finnhub' | 'sec' | null;
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
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapAsOf: string | null;
  eps: ResultPart & { noOfEsts: number | null; lastYear: number | null; lastYearReportDate: string | null };
  revenue: ResultPart & { currency: string };
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
