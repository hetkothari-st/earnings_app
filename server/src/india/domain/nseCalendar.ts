import { DateTime } from 'luxon';

export const IST = 'Asia/Kolkata';

/** YYYY-MM-DD in IST. */
export function todayIST(): string {
  return DateTime.now().setZone(IST).toISODate()!;
}

/** NSE regular session: 09:15–15:30 IST. */
export const NSE_OPEN = '09:15';
export const NSE_CLOSE = '15:30';

/**
 * NSE 2026 trading holidays (weekdays only).
 * Source: NSE India official holiday list 2026, verified 2026-10-15.
 */
export const NSE_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-15', // Makar Sankranti / Pongal
  '2026-01-26', // Republic Day
  '2026-03-03', // Mahashivaratri
  '2026-03-26', // Holi
  '2026-03-31', // Id-Ul-Fitr (Ramzan Eid)
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti / Ram Navami
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Buddha Purnima
  '2026-06-26', // Bakri Eid
  '2026-09-14', // Milad-un-Nabi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Diwali (Laxmi Pujan)
  '2026-11-10', // Gurunanak Jayanti
  '2026-11-24', // Diwali Balipratipada (compensatory)
  '2026-12-25', // Christmas
]);

/** 2027 holidays not yet published — weekends only. */
export function isNseTradingDay(date: string): boolean {
  const dt = DateTime.fromISO(date, { zone: IST });
  const dow = dt.weekday; // 1=Mon … 7=Sun
  if (dow === 6 || dow === 7) return false;
  if (NSE_HOLIDAYS_2026.has(date)) return false;
  // 2027: mark as trading day but the scheduler emits a warning via source_status.
  return true;
}

/** Previous NSE trading day before `date` (YYYY-MM-DD). */
export function prevNseTradingDay(date: string): string {
  let dt = DateTime.fromISO(date, { zone: IST }).minus({ days: 1 });
  while (!isNseTradingDay(dt.toISODate()!)) dt = dt.minus({ days: 1 });
  return dt.toISODate()!;
}

/** Next NSE trading day on or after `date`. */
export function nextNseTradingDay(date: string): string {
  let dt = DateTime.fromISO(date, { zone: IST });
  while (!isNseTradingDay(dt.toISODate()!)) dt = dt.plus({ days: 1 });
  return dt.toISODate()!;
}

/**
 * Classify timing from an IST wall-clock time string "HH:MM" or "HH:MM:SS".
 * BMO < 09:15, DMH 09:15–15:30 inclusive, AMC > 15:30.
 */
export type InTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';

export function timingFromIst(timeStr: string | null | undefined): InTiming {
  if (!timeStr) return 'UNKNOWN';
  const parts = timeStr.split(':');
  if (parts.length < 2) return 'UNKNOWN';
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 'UNKNOWN';
  const total = hh * 60 + mm;
  if (total < 9 * 60 + 15) return 'BMO';
  if (total > 15 * 60 + 30) return 'AMC';
  return 'DMH';
}

/**
 * Parse NSE pubDate format: "DD-Mon-YYYY HH:MM:SS" (IST, no offset marker).
 * Returns a luxon DateTime in IST, or null on parse failure.
 */
export function parseNsePubDate(raw: string): DateTime | null {
  const dt = DateTime.fromFormat(raw.trim(), 'd-MMM-yyyy HH:mm:ss', { zone: IST, locale: 'en-US' });
  return dt.isValid ? dt : null;
}

/** Add calendar days to a YYYY-MM-DD string. */
export function addDaysIST(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: IST }).plus({ days: n }).toISODate()!;
}

/**
 * Timing of a report dated `reportDate` whose results were made public at `released` (IST).
 * Same day: by the clock. Later, but before the next session opens: after close. Anything else
 * (before the result date, or after the next open) is not this report's release: null.
 */
export function timingForRelease(reportDate: string, released: DateTime): InTiming | null {
  const ist = released.setZone(IST);
  const day = ist.toISODate()!;
  if (day < reportDate) return null;
  // On a day without a session the market first reacts at the next open: like after close.
  if (day === reportDate) return isNseTradingDay(day) ? timingFromIst(ist.toFormat('HH:mm')) : 'AMC';
  const nextOpen = DateTime.fromISO(`${nextNseTradingDay(addDaysIST(reportDate, 1))}T${NSE_OPEN}`, { zone: IST });
  return ist < nextOpen ? 'AMC' : null;
}

/** True for 2027 and later, whose NSE holiday list is not in the app yet (weekends only). */
export function holidaysUnknown(date: string): boolean {
  return date >= '2027-01-01';
}
