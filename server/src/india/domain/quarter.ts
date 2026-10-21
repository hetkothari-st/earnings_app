import { DateTime } from 'luxon';
import { IST } from './nseCalendar.js';

/** The four NSE quarter-end dates within a calendar year. */
const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31'];

/**
 * Returns the label for the quarter that ended on `quarterEnd`.
 * e.g. "2026-06-30" → "Jun/2026"
 */
export function quarterLabel(quarterEnd: string): string {
  const dt = DateTime.fromISO(quarterEnd, { zone: IST });
  return dt.toFormat('LLL/yyyy', { locale: 'en-US' });
}

/**
 * The most recent NSE quarter-end strictly before `date` (YYYY-MM-DD).
 * Used to infer quarter from a board-meeting notice date.
 */
export function latestQuarterEndBefore(date: string): string {
  const dt = DateTime.fromISO(date, { zone: IST });
  const year = dt.year;

  // Build candidates from current and previous year
  const candidates: string[] = [];
  for (const end of QUARTER_ENDS) {
    candidates.push(`${year - 1}-${end}`);
    candidates.push(`${year}-${end}`);
    candidates.push(`${year + 1}-${end}`);
  }

  // Find the latest one strictly before `date`
  const sorted = candidates
    .filter((d) => d < date)
    .sort()
    .reverse();
  return sorted[0]!;
}

/**
 * Build a fiscal quarter label from the period-end month+year from XBRL.
 * monthOfPeriodEnded: 1-12, yearOfPeriodEnded: e.g. 2026
 * Returns "Sep/2026" style.
 */
export function quarterFromPeriod(month: number, year: number): string {
  const dt = DateTime.fromObject({ year, month, day: 1 }, { zone: IST }).endOf('month');
  // Snap to nearest quarter end
  const qEnd = QUARTER_ENDS.find((e) => {
    const [m, d] = e.split('-').map(Number) as [number, number];
    return dt.month === m && dt.day === d;
  });
  if (qEnd) return `${dt.toFormat('LLL', { locale: 'en-US' })}/${year}`;
  // Fallback: just use the month/year as-is
  return dt.toFormat('LLL/yyyy', { locale: 'en-US' });
}
