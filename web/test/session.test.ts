import { describe, expect, test } from 'vitest';
import { daySummary, sessionBand } from '../src/lib/session';

describe('sessionBand', () => {
  test('IST on a US daylight-time day: axis 4:00–20:00 ET, regular session 9:30–16:00', () => {
    const b = sessionBand('2026-10-15', '16:00', 'Asia/Kolkata');
    expect(b.open).toBeCloseTo(5.5 / 16);
    expect(b.close).toBeCloseTo(12 / 16);
    expect(b.openLabel).toBe('7:00 PM');
    expect(b.closeLabel).toBe('1:30 AM');
    expect(b.ticks.map((t) => t.label)).toEqual(['3 PM', '6 PM', '9 PM', '12 AM', '3 AM']);
    expect(b.ticks[0]!.at).toBeCloseTo(1.5 / 16);
  });
  test('early close shortens the regular session', () => {
    const b = sessionBand('2026-11-27', '13:00', 'America/New_York');
    expect(b.close).toBeCloseTo(9 / 16);
    expect(b.closeLabel).toBe('1:00 PM');
  });
});

describe('daySummary', () => {
  test('counts per date and session, ordered by date', () => {
    const rows = [
      { symbol: 'A', reportDate: '2026-10-16', timing: 'AMC' as const },
      { symbol: 'B', reportDate: '2026-10-15', timing: 'BMO' as const },
      { symbol: 'C', reportDate: '2026-10-15', timing: 'BMO' as const },
      { symbol: 'D', reportDate: '2026-10-15', timing: 'UNKNOWN' as const },
      { symbol: 'E', reportDate: '2026-10-15', timing: 'DMH' as const },
    ];
    expect(daySummary(rows, new Set(['C']))).toEqual([
      { date: '2026-10-15', bmo: 1, amc: 0, other: 2 },
      { date: '2026-10-16', bmo: 0, amc: 1, other: 0 },
    ]);
  });
});
