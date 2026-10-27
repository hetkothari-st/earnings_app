import { beatMiss, surprisePct } from '../../domain/surprise.js';
import type { JpReport } from '../db/jpRepo.js';
import type { JpFigureDto, JpReportDto } from './types.js';

const TIMING_SOURCES = ['sec-6k', 'sec-notice', 'yahoo'] as const;

interface Side {
  actual: number | null;
  currency: string | null;
  source: JpFigureDto['actualSource'];
  span: JpFigureDto['actualSpan'];
  ytdMonths: JpFigureDto['ytdMonths'];
}

/** Quarter actual vs quarter estimate, or a 12-month YTD actual vs a year estimate. */
function sameSpan(estimateSpan: JpFigureDto['estimateSpan'], s: Side): boolean {
  if (s.span === 'quarter') return estimateSpan === 'quarter';
  return s.span === 'ytd' && s.ytdMonths === 12 && estimateSpan === 'year';
}

function figure(r: JpReport, estimate: number | null, analysts: number | null, s: Side, isEps: boolean): JpFigureDto {
  const ok = r.estimateCurrency != null && s.currency != null && r.estimateCurrency === s.currency
    && sameSpan(r.estimateSpan, s)
    // An SEC EPS is not the figure the consensus tracks: never EPS colour for SEC actuals.
    && !(isEps && s.source === 'sec');
  return {
    estimate, analysts, estimateCurrency: r.estimateCurrency, estimateSpan: r.estimateSpan,
    actual: s.actual, actualCurrency: s.currency, actualSource: s.source, actualSpan: s.span, ytdMonths: s.ytdMonths,
    surprisePct: ok ? surprisePct(s.actual, estimate) : null,
    result: ok ? beatMiss(s.actual, estimate) : null,
  };
}

export function toJpDto(r: JpReport): JpReportDto {
  const timingSource = TIMING_SOURCES.find((s) => s === r.timingSource) ?? null;
  return {
    id: r.id,
    market: 'JP',
    symbol: r.code,
    name: r.name,
    nameJa: r.nameJa,
    level: r.level,
    adrTicker: r.adr,
    adrRatio: r.adrRatio,
    reportDate: r.reportDate,
    dateStatus: r.dateStatus,
    period: r.periodLabel,
    periodEnd: r.periodEnd,
    fiscalQuarter: r.fiscalQuarter,
    fyEnd: r.fyEnd,
    timing: r.timing,
    timingSource,
    releasedAt: r.releasedAt,
    rescheduledFrom: r.rescheduledFrom,
    sector: r.sector,
    industry: r.industry,
    industryJa: r.industryJa,
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    secDocUrl: r.secDocUrl,
    edinetDocId: r.edinetDocId,
    eps: figure(r, r.epsEstimate, r.epsAnalysts,
      { actual: r.epsActual, currency: r.epsCurrency, source: r.epsSource, span: r.epsSpan, ytdMonths: r.epsYtdMonths }, true),
    epsDiluted: r.epsDilutedActual,
    revenue: figure(r, r.revenueEstimate, r.revenueAnalysts,
      { actual: r.revenueActual, currency: r.revenueCurrency, source: r.revenueSource, span: r.revenueSpan, ytdMonths: r.revenueYtdMonths }, false),
    expectedMove: r.expectedMove
      ? {
          adr: r.expectedMove.adr, expiry: r.expectedMove.expiry, strike: r.expectedMove.strike, callMid: r.expectedMove.callMid,
          putMid: r.expectedMove.putMid, underlying: r.expectedMove.underlying, movePct: r.expectedMove.movePct,
          illiquid: r.expectedMove.illiquid, final: r.expectedMove.final, quoteDate: r.expectedMove.quoteDate,
          snapshotAt: r.expectedMove.snapshotAt,
        }
      : null,
    liveMove: r.liveMovePct != null
      ? {
          movePct: r.liveMovePct,
          changePp: r.expectedMove ? Math.round((r.liveMovePct - r.expectedMove.movePct) * 100) / 100 : null,
          illiquid: r.liveMoveIlliquid ?? false,
          quoteTime: r.liveMoveQuoteTime,
        }
      : null,
    previousMove: r.prevMovePct != null && r.prevMoveDate && r.prevMoveBasis
      ? { pct: r.prevMovePct, reportDate: r.prevMoveDate, basis: r.prevMoveBasis }
      : null,
  };
}
