import { beatMiss, surprisePct } from '../../domain/surprise.js';
import type { HkReport } from '../db/hkRepo.js';
import type { HkFigureDto, HkReportDto } from './types.js';

const TIMING_SOURCES = ['sec-6k', 'sec-8k', 'sec-notice', 'yahoo'] as const;

function figure(
  estimate: number | null, analysts: number | null, estimateCurrency: string | null,
  actual: number | null, actualCurrency: string | null, comparable: boolean,
): HkFigureDto {
  const ok = comparable && estimateCurrency != null && actualCurrency != null && estimateCurrency === actualCurrency;
  return {
    estimate, analysts, estimateCurrency, actual, actualCurrency,
    surprisePct: ok ? surprisePct(actual, estimate) : null,
    result: ok ? beatMiss(actual, estimate) : null,
  };
}

export function toHkDto(r: HkReport): HkReportDto {
  const timingSource = TIMING_SOURCES.find((s) => s === r.timingSource) ?? null;
  return {
    id: r.id,
    market: 'HK',
    symbol: r.code,
    name: r.name,
    level: r.level,
    adrTicker: r.adr,
    adrRatio: r.adrRatio,
    reportDate: r.reportDate,
    dateStatus: r.dateStatus,
    period: r.periodLabel,
    periodEnd: r.periodEnd,
    periodKind: r.periodKind,
    timing: r.timing,
    timingSource,
    releasedAt: r.releasedAt,
    rescheduledFrom: r.rescheduledFrom,
    sector: r.sector,
    industry: r.industry,
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    currency: r.epsCurrency ?? r.revenueCurrency ?? r.estimateCurrency,
    epsBasis: r.epsBasis,
    actualSource: r.actualSource,
    secDocUrl: r.secDocUrl,
    // Colour only for the same currency, and for EPS only a per-share actual against the per-share estimate.
    eps: figure(r.epsEstimate, r.epsAnalysts, r.estimateCurrency, r.epsActual, r.epsCurrency, r.epsBasis === 'share'),
    revenue: figure(r.revenueEstimate, r.revenueAnalysts, r.estimateCurrency, r.revenueActual, r.revenueCurrency, true),
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
