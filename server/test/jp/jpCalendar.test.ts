import { describe, it, expect } from 'vitest';
import {
  isJpTradingDay, prevJpTradingDay, jpTimingFromJst, holidaysUnknownJp, jpDateFromUs, jpReactionWindow,
} from '../../src/jp/domain/jpCalendar.js';

describe('jpCalendar', () => {
  it('holidays, substitute days and the year-end closure are closed', () => {
    for (const d of ['2026-09-22', '2026-11-23', '2026-12-31', '2027-01-01', '2027-03-22', '2026-10-24']) {
      expect(isJpTradingDay(d), d).toBe(false);
    }
    expect(isJpTradingDay('2026-11-24')).toBe(true);
    expect(isJpTradingDay('2027-01-04')).toBe(true);
  });
  it('year-end closure applies in unlisted years', () => {
    expect(isJpTradingDay('2028-01-03')).toBe(false);
    expect(holidaysUnknownJp('2028-01-03')).toBe(true);
  });
  it('previous trading day skips the year end', () => {
    expect(prevJpTradingDay('2027-01-04')).toBe('2026-12-30');
  });
  it('timing: lunch counts as during', () => {
    expect(jpTimingFromJst('08:59')).toBe('BMO');
    expect(jpTimingFromJst('09:00')).toBe('DMH');
    expect(jpTimingFromJst('11:45')).toBe('DMH');
    expect(jpTimingFromJst('15:30')).toBe('DMH');
    expect(jpTimingFromJst('15:31')).toBe('AMC');
    expect(jpTimingFromJst(null)).toBe('UNKNOWN');
  });
  it('US date to JST date', () => {
    expect(jpDateFromUs('2026-11-04', 'AMC')).toBe('2026-11-05');
    expect(jpDateFromUs('2026-11-05', 'BMO')).toBe('2026-11-05');
  });
  it('reaction window across the year end', () => {
    expect(jpReactionWindow('2026-12-30', 'AMC')).toEqual({ before: '2026-12-30', after: '2027-01-04' });
  });
});
