import { DateTime } from 'luxon';
import { ET, sessionClose } from '../domain/marketCalendar.js';
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
  const { close, flag: closeFlag } = closeFor(r.reportDate);

  if (r.secCheck === 'contradicted' && r.secAcceptedAt) {
    flags.push({ field: 'timing', message: `SEC 8-K accepted ${etClock(r.secAcceptedAt)} ET, which contradicts ${r.timing}` });
  }
  if (r.timing === 'UNKNOWN') flags.push({ field: 'timing', message: 'Time not announced' });
  if (r.timingConflict) flags.push({ field: 'timing', message: r.timingConflict });
  if (closeFlag) flags.push(closeFlag);
  if (r.marketCapAsOf && r.marketCapAsOf > r.reportDate) {
    flags.push({ field: 'marketCap', message: 'Market cap is current, not at report time' });
  }
  if (r.expectedMove?.illiquid) {
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
    marketCap: r.marketCap,
    marketCapAsOf: r.marketCapAsOf,
    eps: {
      estimate: r.epsEstimate,
      actual: r.epsActual,
      surprisePct: r.epsSurprisePct ?? surprisePct(r.epsActual, r.epsEstimate),
      result: beatMiss(r.epsActual, r.epsEstimate),
      noOfEsts: r.noOfEsts,
    },
    revenue: {
      estimate: r.revenueEstimate,
      actual: r.revenueActual,
      surprisePct: surprisePct(r.revenueActual, r.revenueEstimate),
      result: beatMiss(r.revenueActual, r.revenueEstimate),
    },
    expectedMove: r.expectedMove,
    sec: { check: r.secCheck, acceptedAt: r.secAcceptedAt, docUrl: r.secDocUrl, indexUrl: r.secIndexUrl },
    fetched: { calendar: r.calendarFetchedAt, revenue: r.revenueFetchedAt, sec: r.secCheckedAt },
    flags,
  };
}
