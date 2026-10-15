import { describe, expect, test } from 'vitest';
import { staleSources } from '../src/lib/stale';

const now = Date.parse('2026-10-15T20:00:00Z');

describe('staleSources', () => {
  test('healthy source -> nothing', () => {
    expect(staleSources([{ source: 'nasdaq', lastSuccessAt: '2026-10-15T19:00:00Z', lastError: null, lastErrorAt: null }], now)).toEqual([]);
  });
  test('error newer than last success -> banner with age and error', () => {
    expect(staleSources([{ source: 'nasdaq', lastSuccessAt: '2026-10-15T17:00:00Z', lastError: 'HTTP 403', lastErrorAt: '2026-10-15T19:00:00Z' }], now))
      .toEqual([{ source: 'nasdaq', message: 'Nasdaq data last updated 3h ago (latest attempt failed: HTTP 403)' }]);
  });
  test('never succeeded', () => {
    expect(staleSources([{ source: 'finnhub', lastSuccessAt: null, lastError: 'FINNHUB_TOKEN is not set', lastErrorAt: '2026-10-15T19:00:00Z' }], now))
      .toEqual([{ source: 'finnhub', message: 'Finnhub data never loaded (FINNHUB_TOKEN is not set)' }]);
  });
});
