import { describe, expect, test } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { parseIndexQuote } from '../../src/sources/yahoo.js';

// Shape copied from live ^GSPC response on 2026-10-15.
const body = { chart: { result: [{ meta: {
  symbol: '^GSPC', shortName: 'S&P 500', regularMarketPrice: 7718.94, chartPreviousClose: 7805.45,
  regularMarketTime: 1792010168, currency: 'USD',
} }] } };

describe('parseIndexQuote', () => {
  test('level, previous close, change and quote time', () => {
    expect(parseIndexQuote(body)).toEqual({
      symbol: '^GSPC', price: 7718.94, previousClose: 7805.45, changePct: -1.11,
      asOf: '2026-10-14T20:36:08.000Z', currency: 'USD',
    });
  });
  test('missing price is a format error, never a zero', () => {
    expect(() => parseIndexQuote({ chart: { result: [{ meta: { symbol: '^GSPC' } }] } })).toThrow(SourceFormatError);
  });
});
