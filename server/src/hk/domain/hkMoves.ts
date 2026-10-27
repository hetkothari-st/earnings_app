import { DateTime } from 'luxon';
import { ET, isTradingDay, nextTradingDay, prevTradingDay } from '../../domain/marketCalendar.js';
import { addDaysHKT, hkTradingDayOnOrAfter, isHkTradingDay, prevHkTradingDay, type HkTiming } from './hkCalendar.js';

/**
 * First US session that can react to an HK release (Ruling 6).
 * Known release instant: the first US trading day whose 09:30 ET open is at or after it.
 * BMO / DMH / AMC: first US trading day on or after the HK date. UNKNOWN: strictly after (conservative).
 */
export function firstUsSessionAfterHkRelease(reportDate: string, timing: HkTiming, releasedAt: string | null): string {
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

/** The US close the options quotes are final at: last US close before the HK date. */
export function lastUsCloseBeforeHk(reportDate: string): string {
  return prevTradingDay(reportDate);
}

/** Close-to-close days around an HK report, on the HK calendar (same rule as India). */
export function hkReactionWindow(reportDate: string, timing: Exclude<HkTiming, 'UNKNOWN'>): { before: string; after: string } {
  if (timing === 'AMC') {
    const before = isHkTradingDay(reportDate) ? reportDate : prevHkTradingDay(reportDate);
    return { before, after: hkTradingDayOnOrAfter(addDaysHKT(reportDate, 1)) };
  }
  // Results on a non-trading day react at the next session.
  if (!isHkTradingDay(reportDate)) return { before: prevHkTradingDay(reportDate), after: hkTradingDayOnOrAfter(reportDate) };
  return { before: prevHkTradingDay(reportDate), after: reportDate };
}

/** An ADR's US report row as an HK date: US after-close rolls to the next calendar day, anything else is the same day (Ruling 5). */
export function hkDateFromUs(usDate: string, usTiming: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN'): string {
  return usTiming === 'AMC' ? addDaysHKT(usDate, 1) : usDate;
}
