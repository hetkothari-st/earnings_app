import { DateTime } from 'luxon';

export type LocalTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';

export interface ExchangeCalendar {
  zone: string;
  today(): string;
  addDays(d: string, n: number): string;
  isTradingDay(d: string): boolean;
  prevTradingDay(d: string): string;
  tradingDayOnOrAfter(d: string): string;
  timingFromClock(hhmm: string | null | undefined): LocalTiming;
  holidaysUnknown(d: string): boolean;
}

/**
 * A weekday-and-holiday exchange calendar in one time zone. Years without a holiday list count as
 * weekends-only (plus `closed`). BMO is before `openMin`, DMH is `openMin..closeMin` inclusive
 * (lunch counts), AMC is after `closeMin`; minutes are from local midnight.
 */
export function makeExchangeCalendar(o: {
  zone: string;
  holidays: Record<number, ReadonlySet<string>>;
  closed?: (d: string) => boolean;
  openMin: number;
  closeMin: number;
  unknownFrom: string;
}): ExchangeCalendar {
  const addDays = (d: string, n: number): string =>
    DateTime.fromISO(d, { zone: o.zone }).plus({ days: n }).toISODate()!;

  const isTradingDay = (d: string): boolean => {
    const dow = DateTime.fromISO(d, { zone: o.zone }).weekday; // 1=Mon … 7=Sun
    if (dow === 6 || dow === 7) return false;
    if (o.closed?.(d)) return false;
    return !o.holidays[Number(d.slice(0, 4))]?.has(d);
  };

  const prevTradingDay = (d: string): string => {
    let x = addDays(d, -1);
    while (!isTradingDay(x)) x = addDays(x, -1);
    return x;
  };

  const tradingDayOnOrAfter = (d: string): string => {
    let x = d;
    while (!isTradingDay(x)) x = addDays(x, 1);
    return x;
  };

  const timingFromClock = (hhmm: string | null | undefined): LocalTiming => {
    if (!hhmm) return 'UNKNOWN';
    const parts = hhmm.split(':');
    if (parts.length < 2) return 'UNKNOWN';
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 'UNKNOWN';
    const total = hh * 60 + mm;
    if (total < o.openMin) return 'BMO';
    if (total > o.closeMin) return 'AMC';
    return 'DMH';
  };

  return {
    zone: o.zone,
    today: () => DateTime.now().setZone(o.zone).toISODate()!,
    addDays,
    isTradingDay,
    prevTradingDay,
    tradingDayOnOrAfter,
    timingFromClock,
    holidaysUnknown: (d) => d >= o.unknownFrom,
  };
}
