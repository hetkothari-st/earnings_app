import { beatMiss, surprisePct } from '../../domain/surprise.js';
import type { EuropeReport } from '../db/europeRepo.js';
import { EXCHANGES } from '../exchanges.js';
import { europeAdrRatioShown } from '../universe.js';
import type { EuropeFigureDto, EuropeReportDto } from './types.js';

interface Side {
  estimateCurrency: string | null;
  actual: number | null;
  currency: string | null;
  source: EuropeFigureDto['actualSource'];
  span: EuropeFigureDto['actualSpan'];
  ytdMonths: EuropeFigureDto['ytdMonths'];
}

/** Quarter actual vs quarter estimate, or a 12-month YTD actual vs a year estimate. */
function sameSpan(estimateSpan: EuropeFigureDto['estimateSpan'], s: Side): boolean {
  if (s.span === 'quarter') return estimateSpan === 'quarter';
  return s.span === 'ytd' && s.ytdMonths === 12 && estimateSpan === 'year';
}

function figure(r: EuropeReport, estimate: number | null, analysts: number | null, s: Side, isEps: boolean): EuropeFigureDto {
  // The same currency string (GBp pence ≠ GBP pounds: neither is ever divided by 100) and the same span.
  const ok = s.estimateCurrency != null && s.currency != null && s.estimateCurrency === s.currency
    && sameSpan(r.estimateSpan, s)
    // An SEC EPS is not the figure the consensus tracks: never EPS colour for SEC actuals.
    && !(isEps && s.source === 'sec');
  return {
    estimate, analysts, estimateCurrency: s.estimateCurrency, estimateSpan: r.estimateSpan,
    actual: s.actual, actualCurrency: s.currency, actualSource: s.source, actualSpan: s.span, ytdMonths: s.ytdMonths,
    surprisePct: ok ? surprisePct(s.actual, estimate) : null,
    result: ok ? beatMiss(s.actual, estimate) : null,
  };
}

export function toEuropeDto(r: EuropeReport): EuropeReportDto {
  return {
    id: r.id,
    market: r.market,
    symbol: r.symbol,
    isin: r.isin,
    name: r.name,
    exchange: r.exchange,
    exchangeName: EXCHANGES[r.exchange]?.name ?? r.exchange,
    country: r.country,
    level: r.level,
    adrTicker: r.adr,
    adrRatio: europeAdrRatioShown({ adrRatio: r.adrRatio, adrRatioVerified: r.adrRatioVerified }),
    reportDate: r.reportDate,
    dateStatus: r.dateStatus,
    // Ruling 7: the label shows only once a source confirmed the period end.
    period: r.periodConfirmed ? r.periodLabel : null,
    periodEnd: r.periodEnd,
    fiscalQuarter: r.fiscalQuarter,
    fyEnd: r.fyEnd,
    timing: r.timing,
    timingSource: r.timing === 'UNKNOWN' ? null : r.timingSource,
    releasedAt: r.releasedAt,
    releasedSource: r.releasedAt ? r.releasedSource : null,
    signal: r.releasedAt && r.signalTitle && r.signalUrl ? { title: r.signalTitle, url: r.signalUrl } : null,
    rescheduledFrom: r.rescheduledFrom,
    sector: r.sector,
    industry: r.industry,
    marketCap: r.marketCap,
    marketCapCurrency: r.marketCap != null ? r.marketCapCurrency : null,
    marketCapAsOf: r.marketCapAsOf,
    secDocUrl: r.secDocUrl,
    esefUrl: r.esefUrl,
    eps: figure(r, r.epsEstimate, r.epsAnalysts, {
      estimateCurrency: r.epsEstimateCurrency, actual: r.epsActual, currency: r.epsCurrency, source: r.epsSource, span: r.epsSpan,
      ytdMonths: r.epsYtdMonths,
    }, true),
    epsDiluted: r.epsDilutedActual,
    revenue: figure(r, r.revenueEstimate, r.revenueAnalysts, {
      estimateCurrency: r.revenueEstimateCurrency, actual: r.revenueActual, currency: r.revenueCurrency, source: r.revenueSource,
      span: r.revenueSpan, ytdMonths: r.revenueYtdMonths,
    }, false),
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
