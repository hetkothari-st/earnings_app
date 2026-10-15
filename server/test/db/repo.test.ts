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
  marketCap: 165_900_000_000, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null, ...over,
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

describe('mergeFinnhubRow', () => {
  test('merges Finnhub row across ticker spellings', () => {
    upsertCalendarRow(db, row({ symbol: 'BRK/B', timing: 'UNKNOWN' }), NOW, TODAY);
    const ok = mergeFinnhubRow(db, { symbol: 'BRK.B', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: 9e10, revenueActual: null }, NOW);
    expect(ok).toBe(true);
    expect(all(db)[0]).toMatchObject({ revenueEstimate: 9e10, timing: 'AMC', timingSource: 'finnhub', revenueFetchedAt: NOW });
  });
  test('nasdaq timing wins; disagreement is recorded as a conflict', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null }, NOW);
    expect(all(db)[0]).toMatchObject({ timing: 'BMO', timingSource: 'nasdaq', timingConflict: 'Nasdaq says BMO, Finnhub says AMC' });
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: null, revenueActual: null }, NOW);
    expect(all(db)[0]!.timingConflict).toBeNull();
  });
  test('no matching report -> false', () => {
    expect(mergeFinnhubRow(db, { symbol: 'NONE', reportDate: '2026-10-16', timing: 'BMO', revenueEstimate: 1, revenueActual: 1 }, NOW)).toBe(false);
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
