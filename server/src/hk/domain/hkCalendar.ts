import { DateTime } from 'luxon';

export const HKT = 'Asia/Hong_Kong';

/** HK session: 09:30–12:00 and 13:00–16:00 HKT. */
export const HK_OPEN = '09:30';
export const HK_CLOSE = '16:00';

export type HkTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';

/**
 * HK general holidays (weekday closures only), from gov.hk, checked by hand 2026-10-27:
 * https://www.gov.hk/en/about/abouthk/holiday/2026.htm and /2027.htm.
 * Saturday/Sunday holidays are left out: weekends are already closed. Half-days and typhoons are not modelled.
 */
export const HK_HOLIDAYS: Record<number, ReadonlySet<string>> = {
  2026: new Set([
    '2026-01-01', // New Year
    '2026-02-17', '2026-02-18', '2026-02-19', // Lunar New Year
    '2026-04-03', // Good Friday
    '2026-04-06', // Easter Monday (observed day after Ching Ming Saturday)
    '2026-04-07', // Ching Ming (moved)
    '2026-05-01', // Labour Day
    '2026-05-25', // Birthday of the Buddha
    '2026-06-19', // Tuen Ng
    '2026-07-01', // HKSAR Establishment Day
    '2026-10-01', // National Day
    '2026-10-19', // Chung Yeung
    '2026-12-25', // Christmas Day
  ]),
  2027: new Set([
    '2027-01-01',
    '2027-02-08', '2027-02-09', // Lunar New Year
    '2027-03-26', // Good Friday
    '2027-03-29', // Easter Monday
    '2027-04-05', // Ching Ming
    '2027-05-13', // Birthday of the Buddha
    '2027-06-09', // Tuen Ng
    '2027-07-01',
    '2027-09-16', // day after Mid-Autumn
    '2027-10-01',
    '2027-10-08', // Chung Yeung
    '2027-12-27', // Christmas Day (observed)
  ]),
};

/** YYYY-MM-DD in Hong Kong. */
export function todayHKT(): string {
  return DateTime.now().setZone(HKT).toISODate()!;
}

/** Add calendar days to a YYYY-MM-DD string. */
export function addDaysHKT(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: HKT }).plus({ days: n }).toISODate()!;
}

/** Weekends, then holidays. Years without a list count as weekends-only. */
export function isHkTradingDay(date: string): boolean {
  const dow = DateTime.fromISO(date, { zone: HKT }).weekday; // 1=Mon … 7=Sun
  if (dow === 6 || dow === 7) return false;
  return !HK_HOLIDAYS[Number(date.slice(0, 4))]?.has(date);
}

/** Previous HK trading day, strictly before `date`. */
export function prevHkTradingDay(date: string): string {
  let d = addDaysHKT(date, -1);
  while (!isHkTradingDay(d)) d = addDaysHKT(d, -1);
  return d;
}

/** First HK trading day on or after `date`. */
export function hkTradingDayOnOrAfter(date: string): string {
  let d = date;
  while (!isHkTradingDay(d)) d = addDaysHKT(d, 1);
  return d;
}

/** Timing from an HKT clock "HH:MM[:SS]". BMO < 09:30, DMH 09:30–16:00 inclusive (lunch counts), AMC > 16:00. */
export function hkTimingFromHkt(hhmm: string | null | undefined): HkTiming {
  if (!hhmm) return 'UNKNOWN';
  const parts = hhmm.split(':');
  if (parts.length < 2) return 'UNKNOWN';
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 'UNKNOWN';
  const total = hh * 60 + mm;
  if (total < 9 * 60 + 30) return 'BMO';
  if (total > 16 * 60) return 'AMC';
  return 'DMH';
}

/**
 * SEC acceptance is an upper bound on the release time (EDGAR only accepts 06:00–22:00 ET), so it can
 * prove BMO only: accepted on the report date (HKT) before 09:30 HKT. Anything else proves nothing.
 */
export function hkTimingFromAcceptance(reportDate: string, acceptedAtIso: string): 'BMO' | null {
  const at = DateTime.fromISO(acceptedAtIso, { setZone: true });
  if (!at.isValid) return null;
  const hkt = at.setZone(HKT);
  if (hkt.toISODate() !== reportDate) return null;
  return hkt.hour * 60 + hkt.minute < 9 * 60 + 30 ? 'BMO' : null;
}

/** True for 2028 and later, whose HK holiday list is not in the app yet (weekends only). */
export function holidaysUnknownHk(date: string): boolean {
  return date >= '2028-01-01';
}
