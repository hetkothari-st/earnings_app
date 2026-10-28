import { SourceFormatError } from '../../sources/http.js';

/**
 * gov.uk bank holidays (England and Wales), the LSE's closed weekdays. Source: https://www.gov.uk/bank-holidays.json
 * (robots allows it), live-checked in Task 3: the file covers 2019-01-01 to 2028-12-26.
 */
export function parseGovUkBankHolidays(json: unknown): string[] {
  const events = (json as { 'england-and-wales'?: { events?: unknown } } | null)?.['england-and-wales']?.events;
  if (!Array.isArray(events)) throw new SourceFormatError('gov.uk bank-holidays.json: england-and-wales.events missing');
  const dates = events.map((e) => (e as { date?: unknown } | null)?.date);
  if (dates.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
    throw new SourceFormatError('gov.uk bank-holidays.json: an event has no YYYY-MM-DD date');
  }
  return [...new Set(dates as string[])].sort();
}

/**
 * The England and Wales dates for 2026 and 2027 from the gov.uk file (Task 3 fixture), used until the weekly job has
 * stored the JSON. 12-24 and 12-31 are trading days (half days are not modelled).
 */
export const LSE_HOLIDAYS_SEED: Record<number, ReadonlySet<string>> = {
  2026: new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']),
  2027: new Set(['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']),
};
