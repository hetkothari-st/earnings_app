import { DateTime } from 'luxon';
import { ET, sessionClose } from '../domain/marketCalendar.js';
import { chooseExpiry } from '../domain/expectedMove.js';
import { beatMiss, surprisePct } from '../domain/surprise.js';
import type { ReportRecord } from '../types.js';
import type { Flag, ReportDto } from './types.js';

function closeFor(date: string): { close: '16:00' | '13:00'; flag?: Flag } {
  try {
    return { close: sessionClose(date) };
  } catch {
    return { close: '16:00', flag: { field: 'timing', message: 'Market-hours calendar missing for this year; close assumed 4:00 PM ET' } };
  }
}

const etClock = (wallClock: string) => DateTime.fromISO(wallClock, { zone: ET }).setLocale('en-US').toFormat('h:mm a');

export function toDto(r: ReportRecord): ReportDto {
  const flags: Flag[] = [];
  // Safety net: never show a move whose expiry would not capture the release under the current timing.
  const em = r.expectedMove && chooseExpiry([r.expectedMove.expiry], r.reportDate, r.timing) ? r.expectedMove : null;
  const { close, flag: closeFlag } = closeFor(r.reportDate);

  if (r.secCheck === 'contradicted' && r.secAcceptedAt) {
    flags.push({ field: 'timing', message: `SEC 8-K accepted ${etClock(r.secAcceptedAt)} ET, which contradicts ${r.timing}` });
  }
  if (r.timing === 'UNKNOWN') flags.push({ field: 'timing', message: 'Time not announced' });
  if (r.timingConflict) flags.push({ field: 'timing', message: r.timingConflict });
  if (closeFlag) flags.push(closeFlag);
  if (r.epsConflict) flags.push({ field: 'eps', message: r.epsConflict });
  if (r.marketCapAsOf && r.marketCapAsOf > r.reportDate) {
    flags.push({ field: 'marketCap', message: 'Market cap is current, not at report time' });
  }
  if (em?.illiquid) {
    flags.push({ field: 'expectedMove', message: 'Illiquid options: zero bid or spread over 30% of mid' });
  }

  return {
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    reportDate: r.reportDate,
    fiscalQuarter: r.fiscalQuarter.startsWith('date:') ? null : r.fiscalQuarter,
    timing: r.timing,
    timingSource: r.timingSource,
    sessionClose: close,
    rescheduledFrom: r.rescheduledFrom,
    exchange: r.exchange,
    sector: r.sector,
    industry: r.industry,
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    eps: {
      estimate: r.epsEstimate,
      actual: r.epsActual,
      surprisePct: surprisePct(r.epsActual, r.epsEstimate),
      result: beatMiss(r.epsActual, r.epsEstimate),
      noOfEsts: r.noOfEsts,
      lastYear: r.lastYearEps,
      lastYearReportDate: r.lastYearReportDate,
    },
    revenue: {
      estimate: r.revenueEstimate,
      actual: r.revenueActual,
      surprisePct: surprisePct(r.revenueActual, r.revenueEstimate),
      result: beatMiss(r.revenueActual, r.revenueEstimate),
    },
    expectedMove: em,
    liveMove: r.liveMove ? {
      movePct: r.liveMove.movePct,
      changePp: r.expectedMove ? Math.round((r.liveMove.movePct - r.expectedMove.movePct) * 100) / 100 : null,
      illiquid: r.liveMove.illiquid,
      quoteTime: r.liveMove.quoteTime,
    } : null,
    previousMove: r.prevMovePct != null && r.prevMoveDate
      ? { pct: r.prevMovePct, reportDate: r.prevMoveDate, basis: r.prevMoveBasis ?? 'known' }
      : null,
    sec: { check: r.secCheck, acceptedAt: r.secAcceptedAt, docUrl: r.secDocUrl, indexUrl: r.secIndexUrl },
    fetched: { calendar: r.calendarFetchedAt, revenue: r.revenueFetchedAt, sec: r.secCheckedAt },
    flags,
  };
}
