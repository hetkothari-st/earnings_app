import { describe, it, expect } from 'vitest';
import {
  isHkTradingDay, prevHkTradingDay, hkTimingFromHkt, hkTimingFromAcceptance, holidaysUnknownHk,
} from '../../src/hk/domain/hkCalendar.js';

describe('hkCalendar', () => {
  it('gov.hk holidays and weekends are closed', () => {
    expect(isHkTradingDay('2026-02-17')).toBe(false);
    expect(isHkTradingDay('2026-10-19')).toBe(false);
    expect(isHkTradingDay('2027-02-09')).toBe(false);
    expect(isHkTradingDay('2026-10-24')).toBe(false);
    expect(isHkTradingDay('2026-02-20')).toBe(true);
  });
  it('previous trading day skips Lunar New Year', () => {
    expect(prevHkTradingDay('2026-02-20')).toBe('2026-02-16');
  });
  it('timing: lunch counts as during', () => {
    expect(hkTimingFromHkt('09:29')).toBe('BMO');
    expect(hkTimingFromHkt('09:30')).toBe('DMH');
    expect(hkTimingFromHkt('12:30')).toBe('DMH');
    expect(hkTimingFromHkt('16:00')).toBe('DMH');
    expect(hkTimingFromHkt('16:01')).toBe('AMC');
    expect(hkTimingFromHkt(null)).toBe('UNKNOWN');
  });
  it('acceptance proves BMO only', () => {
    expect(hkTimingFromAcceptance('2026-11-20', '2026-11-20T00:59:00Z')).toBe('BMO');
    expect(hkTimingFromAcceptance('2026-11-20', '2026-11-20T11:30:00Z')).toBeNull();
    expect(hkTimingFromAcceptance('2026-11-20', '2026-11-19T00:59:00Z')).toBeNull();
  });
  it('2028 is flagged unknown', () => {
    expect(holidaysUnknownHk('2028-01-03')).toBe(true);
    expect(holidaysUnknownHk('2027-12-31')).toBe(false);
  });
});
