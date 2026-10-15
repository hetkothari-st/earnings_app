import { beforeEach, describe, expect, test } from 'vitest';
import {
  type Db, getReport, isBackfilled, listRange, listSourceStatus, markBackfilled, mergeFinnhubRow, openDb,
  recordSourceError, recordSourceSuccess, reportsForSnapshot, reportsNeedingSec, saveExpectedMove,
  setExchange, setSecResult, upsertCalendarRow,
} from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T20:00:00.000Z';
const TODAY = '2026-10-15';

const row = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 165_900_000_000, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});

const all = (db: Db) => listRange(db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null });

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('upsertCalendarRow', () => {
  test('inserts with nasdaq timing source and market-cap date', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({
      symbol: 'SCHW', symbolKey: 'SCHW', timing: 'BMO', timingSource: 'nasdaq', marketCap: 165_900_000_000,
      marketCapAsOf: TODAY, calendarFetchedAt: NOW,
    });
  });
  test('keeps known timing when Nasdaq later says not supplied', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ timing: 'UNKNOWN', epsActual: 1.71, epsSurprisePct: 3 }), NOW, '2026-10-17');
    expect(all(db)[0]).toMatchObject({ timing: 'BMO', timingSource: 'nasdaq', epsActual: 1.71, epsSurprisePct: 3 });
  });
  test('market cap is frozen once the report date has passed', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ marketCap: 999 }), NOW, '2026-10-17');
    expect(all(db)[0]).toMatchObject({ marketCap: 165_900_000_000, marketCapAsOf: TODAY });
  });
  test('null fields never erase stored values', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ epsEstimate: null, noOfEsts: null, marketCap: null }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ epsEstimate: 1.66, noOfEsts: 10, marketCap: 165_900_000_000 });
  });
  test('reschedule moves the date, logs the old one, and drops stale timing, SEC result and snapshot', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    const id = all(db)[0]!.id;
    saveExpectedMove(db, id, { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false }, NOW);
    upsertCalendarRow(db, row({ reportDate: '2026-10-21', timing: 'UNKNOWN' }), NOW, TODAY);
    expect(getReport(db, id)).toMatchObject({
      reportDate: '2026-10-21', rescheduledFrom: '2026-10-16', timing: 'UNKNOWN', timingSource: null, expectedMove: null,
    });
  });
});

describe('review fixes', () => {
  const em = { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false };
  test('timing change on the same date drops the expected-move snapshot', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    const id = all(db)[0]!.id;
    saveExpectedMove(db, id, em, NOW);
    upsertCalendarRow(db, row({ timing: 'AMC' }), NOW, TODAY);
    expect(getReport(db, id)!.expectedMove).toBeNull();
  });
  test('unchanged timing keeps the snapshot', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    const id = all(db)[0]!.id;
    saveExpectedMove(db, id, em, NOW);
    upsertCalendarRow(db, row(), NOW, TODAY);
    expect(getReport(db, id)!.expectedMove).not.toBeNull();
  });
  test('Finnhub filling timing drops the snapshot', () => {
    upsertCalendarRow(db, row({ timing: 'UNKNOWN' }), NOW, TODAY);
    const id = all(db)[0]!.id;
    saveExpectedMove(db, id, em, NOW);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null, epsActual: null }, NOW);
    expect(getReport(db, id)!.expectedMove).toBeNull();
  });
  test('row without fiscal quarter merges with the real-quarter row on the same date', () => {
    upsertCalendarRow(db, row({ fiscalQuarter: 'date:2026-10-16', timing: 'UNKNOWN' }), NOW, TODAY);
    upsertCalendarRow(db, row({ fiscalQuarter: 'Sep/2026', timing: 'BMO' }), NOW, TODAY);
    expect(all(db).map((r) => [r.fiscalQuarter, r.timing])).toEqual([['Sep/2026', 'BMO']]);
  });
  test('missing fiscal quarter later reuses the existing row on the same date', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ fiscalQuarter: 'date:2026-10-16', timing: 'UNKNOWN' }), NOW, TODAY);
    expect(all(db).map((r) => [r.fiscalQuarter, r.timing])).toEqual([['Sep/2026', 'BMO']]);
  });
  test('last-year EPS is stored', () => {
    upsertCalendarRow(db, row({ lastYearEps: 1.31, lastYearReportDate: '2025-10-16' }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ lastYearEps: 1.31, lastYearReportDate: '2025-10-16' });
  });
});

describe('EPS actual precedence', () => {
  const fh = (epsActual: number | null) => ({ symbol: 'SCHW', reportDate: '2026-10-16', timing: 'BMO' as const, revenueEstimate: null, revenueActual: null, epsActual });
  test('Finnhub actual fills a missing one', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, fh(1.71), NOW);
    expect(all(db)[0]).toMatchObject({ epsActual: 1.71, epsConflict: null });
  });
  test('Finnhub wins over a differing Nasdaq actual and the disagreement is recorded', () => {
    upsertCalendarRow(db, row({ epsActual: 1.65, epsSurprisePct: -0.6 }), NOW, TODAY);
    mergeFinnhubRow(db, fh(1.71), NOW);
    expect(all(db)[0]).toMatchObject({ epsActual: 1.71, epsConflict: 'Nasdaq reports EPS 1.65, Finnhub 1.71' });
  });
  test('a later Nasdaq refresh does not overwrite the Finnhub actual', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, fh(1.71), NOW);
    upsertCalendarRow(db, row({ epsActual: 1.65 }), NOW, TODAY);
    expect(all(db)[0]!.epsActual).toBe(1.71);
  });
});

describe('mergeFinnhubRow', () => {
  test('merges Finnhub row across ticker spellings', () => {
    upsertCalendarRow(db, row({ symbol: 'BRK/B', timing: 'UNKNOWN' }), NOW, TODAY);
    const ok = mergeFinnhubRow(db, { symbol: 'BRK.B', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: 9e10, revenueActual: null, epsActual: null }, NOW);
    expect(ok).toBe(true);
    expect(all(db)[0]).toMatchObject({ revenueEstimate: 9e10, timing: 'AMC', timingSource: 'finnhub', revenueFetchedAt: NOW });
  });
  test('nasdaq timing wins; disagreement is recorded as a conflict', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null, epsActual: null }, NOW);
    expect(all(db)[0]).toMatchObject({ timing: 'BMO', timingSource: 'nasdaq', timingConflict: 'Nasdaq says BMO, Finnhub says AMC' });
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: null, revenueActual: null, epsActual: null }, NOW);
    expect(all(db)[0]!.timingConflict).toBeNull();
  });
  test('no matching report -> false', () => {
    expect(mergeFinnhubRow(db, { symbol: 'NONE', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: 1, revenueActual: 1, epsActual: null }, NOW)).toBe(false);
  });
});

describe('listRange', () => {
  beforeEach(() => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'TINY', name: 'Tiny Corp', marketCap: 5e8 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'NOCAP', name: 'Unknown Cap', marketCap: null }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'LATER', name: 'Later Inc', reportDate: '2026-11-01' }), NOW, TODAY);
  });
  test('date range and min cap; unknown caps are never filtered out', () => {
    const rows = listRange(db, { from: '2026-10-16', to: '2026-10-16', minCap: 2e9, q: null });
    expect(rows.map((r) => r.symbol)).toEqual(['SCHW', 'NOCAP']);
  });
  test('search by ticker prefix or name', () => {
    expect(listRange(db, { from: '2026-10-01', to: '2026-12-31', minCap: null, q: 'tin' }).map((r) => r.symbol)).toEqual(['TINY']);
    expect(listRange(db, { from: '2026-10-01', to: '2026-12-31', minCap: null, q: 'schwab' }).map((r) => r.symbol)).toEqual(['SCHW']);
  });
});

describe('sec, snapshot, status, backfill helpers', () => {
  test('exchange is set for every row of a symbol', () => {
    upsertCalendarRow(db, row({ symbol: 'BRK/B' }), NOW, TODAY);
    setExchange(db, 'BRK-B', 'NYSE');
    expect(all(db)[0]!.exchange).toBe('NYSE');
  });
  test('reportsNeedingSec: past reports never checked, plus recent unverifiable ones', () => {
    upsertCalendarRow(db, row({ symbol: 'OLD', reportDate: '2026-10-01' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'RECENT', reportDate: '2026-10-14' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'FUTURE', reportDate: '2026-10-20' }), NOW, TODAY);
    const pending = reportsNeedingSec(db, TODAY, '2026-10-10');
    expect(pending.map((p) => p.symbolKey).sort()).toEqual(['OLD', 'RECENT']);
    for (const p of pending) {
      setSecResult(db, p.id, { check: 'unverifiable', timing: p.timing, timingSource: p.timingSource, acceptedAt: null, docUrl: null, indexUrl: null }, NOW);
    }
    expect(reportsNeedingSec(db, TODAY, '2026-10-10').map((p) => p.symbolKey)).toEqual(['RECENT']);
  });
  test('reportsForSnapshot: AMC today, BMO/DMH/UNKNOWN next trading day', () => {
    upsertCalendarRow(db, row({ symbol: 'AMCTODAY', reportDate: TODAY, timing: 'AMC' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BMOTODAY', reportDate: TODAY, timing: 'BMO' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BMONEXT', reportDate: '2026-10-16', timing: 'BMO' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'UNKNEXT', reportDate: '2026-10-16', timing: 'UNKNOWN' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'AMCNEXT', reportDate: '2026-10-16', timing: 'AMC' }), NOW, TODAY);
    expect(reportsForSnapshot(db, TODAY, '2026-10-16').map((r) => r.symbol).sort()).toEqual(['AMCTODAY', 'BMONEXT', 'UNKNEXT']);
  });
  test('source status keeps last success and last error', () => {
    recordSourceSuccess(db, 'nasdaq', NOW);
    recordSourceError(db, 'nasdaq', 'HTTP 403', '2026-10-15T21:00:00.000Z');
    expect(listSourceStatus(db)).toEqual([
      { source: 'nasdaq', lastSuccessAt: NOW, lastError: 'HTTP 403', lastErrorAt: '2026-10-15T21:00:00.000Z' },
    ]);
  });
  test('backfill progress', () => {
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(false);
    markBackfilled(db, 'nasdaq:2026-10-01', NOW);
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(true);
  });
});
