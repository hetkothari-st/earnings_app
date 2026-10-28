import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGovUkBankHolidays, LSE_HOLIDAYS_SEED } from '../../src/europe/domain/bankHolidays.js';
import {
  calendarFor, TRADEGATE_CAL, marketToday, europeDateFromUs, europeReactionWindow, holidaysUnknown,
} from '../../src/europe/domain/calendars.js';
import { SourceFormatError } from '../../src/sources/http.js';

const govuk = JSON.parse(readFileSync(new URL('../fixtures/europe/feeds/govuk_bank_holidays.json', import.meta.url), 'utf8'));

describe('europe calendars', () => {
  it('gov.uk JSON parsed; 2026-12-28 substitute day closed on LSE; 2026-12-24 open', () => {
    const dates = parseGovUkBankHolidays(govuk);
    expect(dates).toEqual([...dates].sort());
    expect(dates).toContain('2026-12-28');
    for (const y of [2026, 2027]) for (const d of LSE_HOLIDAYS_SEED[y]!) expect(dates).toContain(d);
    expect(() => parseGovUkBankHolidays({ scotland: {} })).toThrow(SourceFormatError);
    expect(() => parseGovUkBankHolidays(null)).toThrow(SourceFormatError);
    const lse = calendarFor('LSE', new Set(dates));
    expect(lse.isTradingDay('2026-12-28')).toBe(false);
    expect(lse.isTradingDay('2026-12-24')).toBe(true);
    expect(calendarFor('LSE').isTradingDay('2026-12-28')).toBe(false);
    // stored dates are unioned with the seed
    expect(calendarFor('LSE', new Set(['2026-06-01'])).isTradingDay('2026-06-01')).toBe(false);
    expect(calendarFor('LSE', new Set(['2026-06-01'])).isTradingDay('2026-12-28')).toBe(false);
  });

  it('Oslo closed 2026-05-14 (Ascension) and 2027-05-17; Xetra open 2026-05-25 (Whit Monday)', () => {
    expect(calendarFor('OSL').isTradingDay('2026-05-14')).toBe(false);
    expect(calendarFor('OSL').isTradingDay('2027-05-17')).toBe(false);
    expect(calendarFor('XET').isTradingDay('2026-05-25')).toBe(true);
  });

  it('SIX closed 2026-01-02; Milan closed 2026-12-24; Stockholm closed 2026-06-19', () => {
    expect(calendarFor('SIX').isTradingDay('2026-01-02')).toBe(false);
    expect(calendarFor('MIL').isTradingDay('2026-12-24')).toBe(false);
    expect(calendarFor('STO').isTradingDay('2026-06-19')).toBe(false);
  });

  it('timing: LSE 07:59 BMO, 08:00 DMH, 16:29 DMH, 16:30 AMC; Helsinki 18:30 AMC; Oslo 16:20 AMC', () => {
    const lse = calendarFor('LSE');
    expect(lse.timingFromClock('07:59')).toBe('BMO');
    expect(lse.timingFromClock('08:00')).toBe('DMH');
    expect(lse.timingFromClock('16:29')).toBe('DMH');
    expect(lse.timingFromClock('16:30')).toBe('AMC');
    expect(calendarFor('HEL').timingFromClock('18:30')).toBe('AMC');
    expect(calendarFor('OSL').timingFromClock('16:20')).toBe('AMC');
    expect(lse.timingFromClock(null)).toBe('UNKNOWN');
  });

  it('US AMC 2026-11-05 → LSE 2026-11-06; US BMO → same day', () => {
    expect(europeDateFromUs('LSE', '2026-11-05', 'AMC')).toBe('2026-11-06');
    expect(europeDateFromUs('LSE', '2026-11-05', 'BMO')).toBe('2026-11-05');
  });

  it('reaction window across the LSE Christmas closure', () => {
    expect(europeReactionWindow('LSE', '2026-12-24', 'AMC')).toEqual({ before: '2026-12-24', after: '2026-12-29' });
  });

  it('2028 dates: weekends only and holidaysUnknown true', () => {
    const lse = calendarFor('LSE');
    expect(lse.isTradingDay('2028-12-25')).toBe(true); // a Monday; the holiday is not known
    expect(lse.isTradingDay('2028-12-23')).toBe(false); // a Saturday
    expect(holidaysUnknown('LSE', '2028-01-03')).toBe(true);
    expect(holidaysUnknown('LSE', '2027-12-31')).toBe(false);
  });

  it('Tradegate hours and market clocks', () => {
    expect(TRADEGATE_CAL.zone).toBe('Europe/Berlin');
    expect(TRADEGATE_CAL.timingFromClock('07:59')).toBe('BMO');
    expect(TRADEGATE_CAL.timingFromClock('22:00')).toBe('AMC');
    expect(marketToday('UK')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(marketToday('EU')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
