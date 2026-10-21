import { beatMiss, surprisePct } from '../../domain/surprise.js';
import type { InReport } from '../db/inRepo.js';
import type { InReportDto } from './types.js';

export function toInDto(r: InReport): InReportDto {
  const basis = r.nature === 'Consolidated' ? 'consolidated' : r.nature === 'Standalone' ? 'standalone' : null;
  // An estimate's basis is consolidated; a standalone-only actual is shown without colour.
  const comparable = basis === 'consolidated';
  const revKind = r.revenueKind === 'total-income' || r.revenueKind === 'revenue-from-ops' ? r.revenueKind : null;
  const revComparable = comparable && revKind === 'revenue-from-ops';
  return {
    id: r.id,
    market: 'IN',
    symbol: r.symbol,
    name: r.name,
    reportDate: r.reportDate ?? '',
    dateStatus: r.dateStatus,
    fiscalQuarter: r.quarterLabel,
    quarterEnd: r.quarterEnd,
    timing: r.timing,
    timingSource: r.timingSource === 'nse-filing' || r.timingSource === 'nse-announcement' ? r.timingSource : null,
    releasedAt: r.releasedAt,
    rescheduledFrom: r.rescheduledFrom,
    sector: r.sector,
    industry: r.industry,
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    basis,
    eps: {
      estimate: r.epsEstimate,
      analysts: r.epsAnalysts,
      actual: r.epsActual,
      surprisePct: comparable ? surprisePct(r.epsActual, r.epsEstimate) : null,
      result: comparable ? beatMiss(r.epsActual, r.epsEstimate) : null,
    },
    revenue: {
      estimate: r.revenueEstimate,
      analysts: r.revenueAnalysts,
      actual: r.revenueActual,
      kind: revKind,
      surprisePct: revComparable ? surprisePct(r.revenueActual, r.revenueEstimate) : null,
      result: revComparable ? beatMiss(r.revenueActual, r.revenueEstimate) : null,
    },
    profit: { actual: r.pnlActual },
    expectedMove: r.expectedMove
      ? {
          expiry: r.expectedMove.expiry, strike: r.expectedMove.strike, callMid: r.expectedMove.callMid,
          putMid: r.expectedMove.putMid, underlying: r.expectedMove.underlying, movePct: r.expectedMove.movePct,
          illiquid: r.expectedMove.illiquid, final: r.expectedMove.final, snapshotAt: r.expectedMove.snapshotAt,
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
