import { describe, expect, test } from 'vitest';
import { finnhubTiming, parseFinnhubEarnings } from '../../src/sources/finnhub.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shape per Finnhub /calendar/earnings docs; numbers are test values.
const body = {
  earningsCalendar: [
    { date: '2026-10-13', epsActual: 5.75, epsEstimate: 5.94, hour: 'bmo', quarter: 3,
      revenueActual: 47_100_000_000, revenueEstimate: 46_500_000_000, symbol: 'JPM', year: 2026 },
    { date: '2026-10-15', epsActual: null, epsEstimate: 1.2, hour: '', quarter: 3,
      revenueActual: null, revenueEstimate: null, symbol: 'BRK.B', year: 2026 },
  ],
};

describe('finnhub', () => {
  test('hour mapping', () => {
    expect(finnhubTiming('bmo')).toBe('BMO');
    expect(finnhubTiming('amc')).toBe('AMC');
    expect(finnhubTiming('dmh')).toBe('DMH');
    expect(finnhubTiming('')).toBe('UNKNOWN');
    expect(finnhubTiming(null)).toBe('UNKNOWN');
  });
  test('parses items', () => {
    expect(parseFinnhubEarnings(body)).toEqual([
      { symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO', revenueEstimate: 46_500_000_000, revenueActual: 47_100_000_000, epsActual: 5.75 },
      { symbol: 'BRK.B', reportDate: '2026-10-15', timing: 'UNKNOWN', revenueEstimate: null, revenueActual: null, epsActual: null },
    ]);
  });
  test('bad shape throws', () => {
    expect(() => parseFinnhubEarnings({ error: 'You don\'t have access' })).toThrow(SourceFormatError);
  });
});
