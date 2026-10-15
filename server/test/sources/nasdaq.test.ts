import { describe, expect, test } from 'vitest';
import { nasdaqTiming, parseNasdaqCalendar } from '../../src/sources/nasdaq.js';
import { SourceFormatError } from '../../src/sources/http.js';

// Shapes copied from live responses on 2026-10-15.
const upcoming = {
  data: {
    asOf: 'Thu, Oct 15, 2026',
    rows: [
      { lastYearRptDt: '10/16/2025', lastYearEPS: '$1.31', time: 'time-pre-market', symbol: 'SCHW',
        name: 'The Charles Schwab Corporation', marketCap: '$165,912,461,000', fiscalQuarterEnding: 'Sep/2026',
        epsForecast: '$1.66', noOfEsts: '10' },
      { time: 'time-after-hours', symbol: 'BRK/B', name: ' Berkshire ', marketCap: 'N/A',
        fiscalQuarterEnding: null, epsForecast: '', noOfEsts: 'N/A' },
    ],
  },
};
const past = {
  data: { rows: [
    { eps: '$5.75', surprise: '-3.2', time: 'time-not-supplied', symbol: 'JPM', name: 'J P Morgan Chase & Co',
      marketCap: '$881,002,680,000', fiscalQuarterEnding: 'Sep/2026', epsForecast: '$5.94', noOfEsts: '6' },
  ] },
};
const weekend = { data: { asOf: 'Sun, Oct 18, 2026', headers: null, rows: null }, message: null, status: { rCode: 200 } };

describe('nasdaqTiming', () => {
  test('maps known values, anything else is UNKNOWN', () => {
    expect(nasdaqTiming('time-pre-market')).toBe('BMO');
    expect(nasdaqTiming('time-after-hours')).toBe('AMC');
    expect(nasdaqTiming('time-not-supplied')).toBe('UNKNOWN');
    expect(nasdaqTiming(undefined)).toBe('UNKNOWN');
  });
});

describe('parseNasdaqCalendar', () => {
  test('upcoming rows', () => {
    const rows = parseNasdaqCalendar(upcoming, '2026-10-15');
    expect(rows[0]).toEqual({
      symbol: 'SCHW', name: 'The Charles Schwab Corporation', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026',
      timing: 'BMO', marketCap: 165912461000, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
      lastYearEps: 1.31, lastYearReportDate: '2025-10-16',
    });
    expect(rows[1]).toMatchObject({
      symbol: 'BRK/B', name: 'Berkshire', timing: 'AMC', marketCap: null, epsEstimate: null, noOfEsts: null,
      fiscalQuarter: 'date:2026-10-15',
    });
  });
  test('past rows carry actuals', () => {
    expect(parseNasdaqCalendar(past, '2026-10-13')[0]).toMatchObject({ epsActual: 5.75, epsSurprisePct: -3.2, timing: 'UNKNOWN' });
  });
  test('EPS shown before Nasdaq records the surprise is a placeholder, not the actual', () => {
    // Live 2026-10-14: BLK eps $11.55 with surprise N/A was last year's EPS; the real Q3 2026 figure was 15.93.
    const rows = parseNasdaqCalendar({ data: { rows: [{ eps: '$11.55', surprise: 'N/A', time: 'time-pre-market', symbol: 'BLK',
      name: 'BlackRock', marketCap: '$1', fiscalQuarterEnding: 'Sep/2026', epsForecast: '$14.01', noOfEsts: '6' }] } }, '2026-10-14');
    expect(rows[0]).toMatchObject({ epsActual: null, epsSurprisePct: null });
  });
  test('weekend response yields no rows', () => {
    expect(parseNasdaqCalendar(weekend, '2026-10-18')).toEqual([]);
  });
  test('HTTP-200 error envelope is a failure, not an empty day', () => {
    expect(() => parseNasdaqCalendar({ data: null, message: 'error', status: { rCode: 400 } }, '2026-10-15')).toThrow(SourceFormatError);
    expect(() => parseNasdaqCalendar({ data: { rows: [] }, status: { rCode: 500 } }, '2026-10-15')).toThrow(SourceFormatError);
  });
  test('last-year EPS and report date', () => {
    expect(parseNasdaqCalendar(upcoming, '2026-10-15')[1]).toMatchObject({ lastYearEps: null, lastYearReportDate: null });
  });
  test('unexpected shape throws SourceFormatError', () => {
    expect(() => parseNasdaqCalendar({ data: { rows: [{ symbol: 5 }] } }, '2026-10-15')).toThrow(SourceFormatError);
    expect(() => parseNasdaqCalendar('<html>blocked</html>', '2026-10-15')).toThrow(SourceFormatError);
  });
});
