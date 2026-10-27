import { describe, it, expect } from 'vitest';
import { makeExchangeCalendar } from '../../src/domain/exchangeCalendar.js';

describe('exchangeCalendar', () => {
  it('a calendar with a closed rule and a holiday list', () => {
    const cal = makeExchangeCalendar({
      zone: 'Asia/Tokyo',
      holidays: { 2026: new Set(['2026-03-02']) },
      closed: (d) => d.slice(5) === '06-15',
      openMin: 600,
      closeMin: 900,
      unknownFrom: '2027-01-01',
    });
    expect(cal.isTradingDay('2026-03-02')).toBe(false); // listed holiday (Monday)
    expect(cal.isTradingDay('2026-06-15')).toBe(false); // closed rule (Monday)
    expect(cal.isTradingDay('2026-03-07')).toBe(false); // Saturday
    expect(cal.isTradingDay('2026-03-03')).toBe(true);
    expect(cal.isTradingDay('2030-03-04')).toBe(true); // unlisted year: weekends only
    expect(cal.prevTradingDay('2026-03-03')).toBe('2026-02-27');
    expect(cal.tradingDayOnOrAfter('2026-03-07')).toBe('2026-03-09');
    expect(cal.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(cal.timingFromClock('09:59')).toBe('BMO');
    expect(cal.timingFromClock('10:00')).toBe('DMH');
    expect(cal.timingFromClock('15:00:30')).toBe('DMH');
    expect(cal.timingFromClock('15:01')).toBe('AMC');
    expect(cal.timingFromClock(undefined)).toBe('UNKNOWN');
    expect(cal.timingFromClock('garbage')).toBe('UNKNOWN');
    expect(cal.holidaysUnknown('2026-12-31')).toBe(false);
    expect(cal.holidaysUnknown('2027-01-01')).toBe(true);
    expect(cal.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
