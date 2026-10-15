import { DateTime } from 'luxon';

export const ET = 'America/New_York';

// NYSE full-day closures. Source: nyse.com/markets/hours-calendars (2026-2027 verified 2026-10-15). Extend yearly.
const HOLIDAYS: Record<number, string[]> = {
  2024: ['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25'],
  2025: ['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
};

// NYSE 1:00 PM ET early closes.
const EARLY_CLOSES: Record<number, string[]> = {
  2024: ['2024-07-03', '2024-11-29', '2024-12-24'],
  2025: ['2025-07-03', '2025-11-28', '2025-12-24'],
  2026: ['2026-11-27', '2026-12-24'],
  2027: ['2027-11-26'],
};

function covered(date: string): number {
  const y = Number(date.slice(0, 4));
  if (!(y in HOLIDAYS)) throw new RangeError(`Market calendar does not cover ${date}; add ${y} to marketCalendar.ts`);
  return y;
}

function dt(date: string): DateTime {
  return DateTime.fromISO(date, { zone: ET });
}

export function addDays(date: string, n: number): string {
  return dt(date).plus({ days: n }).toISODate()!;
}

export function isWeekend(date: string): boolean {
  return dt(date).weekday > 5;
}

export function isTradingDay(date: string): boolean {
  const y = covered(date);
  return !isWeekend(date) && !HOLIDAYS[y]!.includes(date);
}

export function sessionClose(date: string): '16:00' | '13:00' {
  const y = covered(date);
  return EARLY_CLOSES[y]!.includes(date) ? '13:00' : '16:00';
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

export function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}

export function todayET(now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(ET).toISODate()!;
}
