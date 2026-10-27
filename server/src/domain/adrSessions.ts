import { DateTime } from 'luxon';
import { ET, isTradingDay, nextTradingDay, prevTradingDay } from './marketCalendar.js';
import type { ExchangeCalendar, LocalTiming } from './exchangeCalendar.js';

/**
 * First US session that can react to a local (HK / Tokyo) release (HK Ruling 6).
 * Known release instant: the first US trading day whose 09:30 ET open is at or after it.
 * BMO / DMH / AMC: first US trading day on or after the local date. UNKNOWN: strictly after (conservative).
 */
export function firstUsSessionAfterRelease(reportDate: string, timing: LocalTiming, releasedAt: string | null): string {
  if (releasedAt) {
    const at = DateTime.fromISO(releasedAt, { setZone: true });
    if (at.isValid) {
      let d = at.setZone(ET).toISODate()!;
      for (;;) {
        if (isTradingDay(d) && DateTime.fromISO(`${d}T09:30`, { zone: ET }) >= at) return d;
        d = DateTime.fromISO(d, { zone: ET }).plus({ days: 1 }).toISODate()!;
      }
    }
  }
  if (timing === 'UNKNOWN') return nextTradingDay(reportDate);
  return isTradingDay(reportDate) ? reportDate : nextTradingDay(reportDate);
}

/** The US close the options quotes are final at: last US close before the local date. */
export function lastUsCloseBefore(reportDate: string): string {
  return prevTradingDay(reportDate);
}

/** Close-to-close days around a local report, on the local calendar (same rule as India). */
export function reactionWindow(
  cal: ExchangeCalendar, reportDate: string, timing: Exclude<LocalTiming, 'UNKNOWN'>,
): { before: string; after: string } {
  if (timing === 'AMC') {
    const before = cal.isTradingDay(reportDate) ? reportDate : cal.prevTradingDay(reportDate);
    return { before, after: cal.tradingDayOnOrAfter(cal.addDays(reportDate, 1)) };
  }
  // Results on a non-trading day react at the next session.
  if (!cal.isTradingDay(reportDate)) return { before: cal.prevTradingDay(reportDate), after: cal.tradingDayOnOrAfter(reportDate) };
  return { before: cal.prevTradingDay(reportDate), after: reportDate };
}

/** An ADR's US report row as a local date: US after-close rolls to the next calendar day, anything else is the same day (Ruling 5). */
export function localDateFromUs(cal: ExchangeCalendar, usDate: string, usTiming: LocalTiming): string {
  return usTiming === 'AMC' ? cal.addDays(usDate, 1) : usDate;
}
