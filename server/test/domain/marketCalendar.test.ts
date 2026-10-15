import { describe, expect, test } from 'vitest';
import {
  addDays, isTradingDay, isWeekend, nextTradingDay, prevTradingDay,
  sessionClose, todayET, tradingDaysBetween,
} from '../../src/domain/marketCalendar.js';

describe('market calendar', () => {
  test('weekdays trade, weekends and holidays do not', () => {
    expect(isTradingDay('2026-10-15')).toBe(true);   // Thu
    expect(isTradingDay('2026-10-17')).toBe(false);  // Sat
    expect(isTradingDay('2026-11-26')).toBe(false);  // Thanksgiving
    expect(isTradingDay('2026-07-03')).toBe(false);  // Independence Day observed
    expect(isTradingDay('2025-01-09')).toBe(false);  // National day of mourning
  });
  test('early close days', () => {
    expect(sessionClose('2026-11-27')).toBe('13:00');
    expect(sessionClose('2026-12-24')).toBe('13:00');
    expect(sessionClose('2026-10-15')).toBe('16:00');
  });
  test('next/prev trading day skip weekends and holidays', () => {
    expect(nextTradingDay('2026-11-25')).toBe('2026-11-27');
    expect(prevTradingDay('2026-10-19')).toBe('2026-10-16');
    expect(nextTradingDay('2026-10-16')).toBe('2026-10-19');
  });
  test('tradingDaysBetween is inclusive', () => {
    expect(tradingDaysBetween('2026-10-15', '2026-10-20'))
      .toEqual(['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']);
  });
  test('2028 holidays and early closes (nyse.com, fetched 2026-10-15)', () => {
    for (const d of ['2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25']) {
      expect(isTradingDay(d), d).toBe(false);
    }
    expect(isTradingDay('2028-01-03')).toBe(true); // New Year's Day falls on Saturday; none observed
    expect(sessionClose('2028-07-03')).toBe('13:00');
    expect(sessionClose('2028-11-24')).toBe('13:00');
    expect(sessionClose('2028-12-22')).toBe('16:00');
    expect(prevTradingDay('2028-01-03')).toBe('2027-12-31');
  });
  test('uncovered years throw instead of guessing', () => {
    expect(() => isTradingDay('2030-01-02')).toThrow(RangeError);
  });
  test('isWeekend works for any year', () => {
    expect(isWeekend('2030-01-05')).toBe(true);
  });
  test('addDays and todayET', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // 2026-10-15T03:00Z is still Oct 14 in New York
    expect(todayET(new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-14');
  });
});
