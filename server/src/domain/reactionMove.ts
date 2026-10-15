import type { Timing } from '../types.js';
import { nextTradingDay, prevTradingDay } from './marketCalendar.js';

/**
 * Close-to-close stock move that captured an earnings release, in percent (1 decimal).
 * BMO/DMH: previous close -> report-day close. AMC: report-day close -> next-day close.
 * Unknown timing or a missing close -> null (never guessed).
 */
export function reactionMove(closes: Map<string, number>, reportDate: string, timing: Timing): number | null {
  let before: string;
  let after: string;
  if (timing === 'BMO' || timing === 'DMH') {
    before = prevTradingDay(reportDate);
    after = reportDate;
  } else if (timing === 'AMC') {
    before = reportDate;
    after = nextTradingDay(reportDate);
  } else {
    return null;
  }
  const a = closes.get(before);
  const b = closes.get(after);
  if (a == null || b == null || a <= 0) return null;
  return Math.round(((b - a) / a) * 1000) / 10;
}
