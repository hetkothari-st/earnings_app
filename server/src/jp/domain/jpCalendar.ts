import { makeExchangeCalendar, type ExchangeCalendar, type LocalTiming } from '../../domain/exchangeCalendar.js';
import { reactionWindow, localDateFromUs } from '../../domain/adrSessions.js';

export const JST = 'Asia/Tokyo';

/** TSE session: 09:00–11:30 and 12:30–15:30 JST (close moved from 15:00 on 2024-11-05). */
export const JP_OPEN = '09:00';
export const JP_CLOSE = '15:30';

export type JpTiming = LocalTiming;

/**
 * Japanese national holidays on weekdays (incl. substitute and citizens' holidays), typed by hand from
 * the Cabinet Office list, checked 2026-10-27: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
 * Weekend holidays are left out (2026-05-03 and 2027-03-21 are Sundays; their substitutes are listed).
 * The TSE year-end closure (12-31..01-03) is a rule, not part of this list. Half-days and outages are not modelled.
 */
export const JP_HOLIDAYS: Record<number, ReadonlySet<string>> = {
  2026: new Set([
    '2026-01-01', // New Year
    '2026-01-12', // Coming of Age
    '2026-02-11', // National Foundation
    '2026-02-23', // Emperor's Birthday
    '2026-03-20', // Vernal Equinox
    '2026-04-29', // Showa
    '2026-05-04', // Greenery
    '2026-05-05', // Children's
    '2026-05-06', // substitute for Constitution Day (Sunday 05-03)
    '2026-07-20', // Marine
    '2026-08-11', // Mountain
    '2026-09-21', // Respect for the Aged
    '2026-09-22', // citizens' holiday
    '2026-09-23', // Autumnal Equinox
    '2026-10-12', // Sports
    '2026-11-03', // Culture
    '2026-11-23', // Labour Thanksgiving
  ]),
  2027: new Set([
    '2027-01-01',
    '2027-01-11',
    '2027-02-11',
    '2027-02-23',
    '2027-03-22', // substitute for Vernal Equinox (Sunday 03-21)
    '2027-04-29',
    '2027-05-03',
    '2027-05-04',
    '2027-05-05',
    '2027-07-19',
    '2027-08-11',
    '2027-09-20',
    '2027-09-23',
    '2027-10-11',
    '2027-11-03',
    '2027-11-23',
  ]),
};

/** TSE year-end closure: 12-31 to 01-03 every year. */
const yearEndClosed = (d: string): boolean => {
  const md = d.slice(5);
  return md === '12-31' || md === '01-01' || md === '01-02' || md === '01-03';
};

export const JP_CAL: ExchangeCalendar = makeExchangeCalendar({
  zone: JST,
  holidays: JP_HOLIDAYS,
  closed: yearEndClosed,
  openMin: 9 * 60,
  closeMin: 15 * 60 + 30,
  unknownFrom: '2028-01-01',
});

/** YYYY-MM-DD in Tokyo. */
export const todayJST = (): string => JP_CAL.today();
export const addDaysJST = (date: string, n: number): string => JP_CAL.addDays(date, n);
export const isJpTradingDay = (date: string): boolean => JP_CAL.isTradingDay(date);
export const prevJpTradingDay = (date: string): string => JP_CAL.prevTradingDay(date);
export const jpTradingDayOnOrAfter = (date: string): string => JP_CAL.tradingDayOnOrAfter(date);

/** Timing from a JST clock "HH:MM[:SS]". BMO < 09:00, DMH 09:00–15:30 inclusive (lunch counts), AMC > 15:30. */
export const jpTimingFromJst = (hhmm: string | null | undefined): JpTiming => JP_CAL.timingFromClock(hhmm);

/** True for 2028 and later, whose holiday list is not in the app yet (weekends and year-end closure only). */
export const holidaysUnknownJp = (date: string): boolean => JP_CAL.holidaysUnknown(date);

/** Close-to-close days around a Tokyo report, on the Tokyo calendar. */
export const jpReactionWindow = (reportDate: string, timing: Exclude<JpTiming, 'UNKNOWN'>): { before: string; after: string } =>
  reactionWindow(JP_CAL, reportDate, timing);

/** An ADR's US report row as a JST date. */
export const jpDateFromUs = (usDate: string, usTiming: JpTiming): string => localDateFromUs(JP_CAL, usDate, usTiming);
