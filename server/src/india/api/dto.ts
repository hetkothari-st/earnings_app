import { beatMiss, surprisePct } from '../../domain/surprise.js';
import type { InReport } from '../db/inRepo.js';
import type { InReportDto } from './types.js';

const lower = (n: string | null) => (n === 'Consolidated' ? 'consolidated' : n === 'Standalone' ? 'standalone' : null);

export function toInDto(r: InReport): InReportDto {
  // A preliminary value (results PDF) is shown until the XBRL filing confirms or corrects it.
  const epsPre = r.epsPrelim != null;
  const revPre = r.revenuePrelim != null;
  const pnlPre = r.pnlPrelim != null;
  const official = lower(r.nature);
  const prelim = lower(r.prelimBasis);
  const basis = (epsPre || revPre || pnlPre) && prelim ? prelim : official;
  const epsActual = epsPre ? r.epsPrelim : r.epsActual;
  const revenueActual = revPre ? r.revenuePrelim : r.revenueActual;
  // An estimate's basis is consolidated; a standalone-only figure is shown without colour. A consolidated
  // preliminary value is coloured like an official one.
  const comparable = (epsPre ? prelim : official) === 'consolidated';
  const revKind = r.revenueKind === 'total-income' || r.revenueKind === 'revenue-from-ops' ? r.revenueKind : null;
  const revComparable = (revPre ? prelim : official) === 'consolidated' && revKind === 'revenue-from-ops';
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
    sharesOutstanding: r.sharesOutstanding,
    basis,
    eps: {
      estimate: r.epsEstimate,
      analysts: r.epsAnalysts,
      actual: epsActual,
      surprisePct: comparable ? surprisePct(epsActual, r.epsEstimate) : null,
      result: comparable ? beatMiss(epsActual, r.epsEstimate) : null,
      preliminary: epsPre,
      corrected: r.epsCorrected,
    },
    revenue: {
      estimate: r.revenueEstimate,
      analysts: r.revenueAnalysts,
      actual: revenueActual,
      kind: revKind,
      surprisePct: revComparable ? surprisePct(revenueActual, r.revenueEstimate) : null,
      result: revComparable ? beatMiss(revenueActual, r.revenueEstimate) : null,
      preliminary: revPre,
      corrected: r.revenueCorrected,
    },
    profit: { actual: pnlPre ? r.pnlPrelim : r.pnlActual, preliminary: pnlPre, corrected: r.pnlCorrected },
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
