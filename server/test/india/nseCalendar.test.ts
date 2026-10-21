import { describe, it, expect } from 'vitest';
import {
  isNseTradingDay,
  prevNseTradingDay,
  nextNseTradingDay,
  timingFromIst,
  parseNsePubDate,
} from '../../src/india/domain/nseCalendar.js';

describe('isNseTradingDay', () => {
  it('returns false for weekends', () => {
    expect(isNseTradingDay('2026-10-17')).toBe(false); // Saturday
    expect(isNseTradingDay('2026-10-18')).toBe(false); // Sunday
  });
  it('returns false for declared NSE holidays', () => {
    expect(isNseTradingDay('2026-01-26')).toBe(false); // Republic Day
    expect(isNseTradingDay('2026-10-02')).toBe(false); // Gandhi Jayanti
    expect(isNseTradingDay('2026-10-20')).toBe(false); // Diwali
    expect(isNseTradingDay('2026-12-25')).toBe(false); // Christmas
  });
  it('returns true for regular trading days', () => {
    expect(isNseTradingDay('2026-10-16')).toBe(true); // Friday
    expect(isNseTradingDay('2026-10-19')).toBe(true); // Monday
  });
});

describe('prevNseTradingDay', () => {
  it('skips weekends', () => {
    expect(prevNseTradingDay('2026-10-19')).toBe('2026-10-16'); // Monday → Friday
  });
  it('skips holidays', () => {
    // Gandhi Jayanti 2026-10-02 is Friday; prev trading day is 2026-10-01 (Thursday)
    expect(prevNseTradingDay('2026-10-02')).toBe('2026-10-01');
  });
});

describe('nextNseTradingDay', () => {
  it('skips weekends from Friday', () => {
    expect(nextNseTradingDay('2026-10-17')).toBe('2026-10-19'); // Sat → Mon
  });
  it('returns same day if already a trading day', () => {
    expect(nextNseTradingDay('2026-10-16')).toBe('2026-10-16');
  });
});

describe('timingFromIst', () => {
  it('classifies BMO before 09:15', () => {
    expect(timingFromIst('08:00')).toBe('BMO');
    expect(timingFromIst('09:14')).toBe('BMO');
  });
  it('classifies DMH during session', () => {
    expect(timingFromIst('09:15')).toBe('DMH');
    expect(timingFromIst('12:30')).toBe('DMH');
    expect(timingFromIst('15:30')).toBe('DMH');
  });
  it('classifies AMC after 15:30', () => {
    expect(timingFromIst('15:31')).toBe('AMC');
    expect(timingFromIst('16:00')).toBe('AMC');
    expect(timingFromIst('18:45:00')).toBe('AMC');
  });
  it('returns UNKNOWN for null/empty', () => {
    expect(timingFromIst(null)).toBe('UNKNOWN');
    expect(timingFromIst('')).toBe('UNKNOWN');
    expect(timingFromIst('notaTime')).toBe('UNKNOWN');
  });
});

describe('parseNsePubDate', () => {
  it('parses standard NSE pubDate format', () => {
    const dt = parseNsePubDate('15-Oct-2026 14:31:00');
    expect(dt).not.toBeNull();
    expect(dt!.toISODate()).toBe('2026-10-15');
    expect(dt!.hour).toBe(14);
    expect(dt!.minute).toBe(31);
  });
  it('returns null for bad input', () => {
    expect(parseNsePubDate('garbage')).toBeNull();
    expect(parseNsePubDate('')).toBeNull();
  });
});
