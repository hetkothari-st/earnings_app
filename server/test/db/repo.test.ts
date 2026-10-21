import { beforeEach, describe, expect, test } from 'vitest';
import {
  type Db, getReport, isBackfilled, listRange, listSourceStatus, markBackfilled, mergeFinnhubRow, openDb,
  recordSourceError, recordSourceSuccess, reportsForSnapshot, reportsNeedingSec, saveExpectedMove,
  setExchange, setSecResult, upsertCalendarRow, reportsNeedingPrevMove, mergeYahooFill, liveSymbols,
} from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  test('reschedule clears every SEC field, including links and check time', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    const id = all(db)[0]!.id;
    setSecResult(db, id, {
      check: 'verified', timing: 'BMO', timingSource: 'sec', acceptedAt: '2026-10-16T11:00:00Z',
      docUrl: 'https://sec.gov/doc.htm', indexUrl: 'https://sec.gov/index.htm',
    }, NOW);
    upsertCalendarRow(db, row({ reportDate: '2026-10-21', timing: 'UNKNOWN' }), NOW, TODAY);
    expect(getReport(db, id)).toMatchObject({
      secCheck: null, secAcceptedAt: null, secDocUrl: null, secIndexUrl: null, secCheckedAt: null,
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
  test('confirmed Nasdaq actual wins (same basis as its estimate); disagreement is recorded', () => {
    // Live JPM Q3 2026: Nasdaq 5.75 adjusted (estimate 5.94 adjusted), Finnhub 5.57 GAAP.
    upsertCalendarRow(db, row({ epsActual: 5.75, epsSurprisePct: -3.2 }), NOW, TODAY);
    mergeFinnhubRow(db, fh(5.57), NOW);
    expect(all(db)[0]).toMatchObject({ epsActual: 5.75, epsConflict: 'Nasdaq reports EPS 5.75, Finnhub 5.57 (often adjusted vs GAAP)' });
  });
  test('a confirmed Nasdaq actual arriving later replaces the Finnhub one and records the difference', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, fh(5.57), NOW);
    upsertCalendarRow(db, row({ epsActual: 5.75, epsSurprisePct: -3.2 }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ epsActual: 5.75, epsConflict: 'Nasdaq reports EPS 5.75, Finnhub 5.57 (often adjusted vs GAAP)' });
  });
  test('agreeing sources leave no conflict', () => {
    upsertCalendarRow(db, row({ epsActual: 1.71, epsSurprisePct: 3 }), NOW, TODAY);
    mergeFinnhubRow(db, fh(1.71), NOW);
    expect(all(db)[0]!.epsConflict).toBeNull();
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
  test('Nasdaq changing its timing on the same date clears the stale conflict', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null, epsActual: null }, NOW);
    expect(all(db)[0]!.timingConflict).toBe('Nasdaq says BMO, Finnhub says AMC');
    upsertCalendarRow(db, row({ timing: 'AMC' }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ timing: 'AMC', timingConflict: null });
  });
  test('unchanged Nasdaq timing keeps the conflict', () => {
    upsertCalendarRow(db, row(), NOW, TODAY);
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'AMC', revenueEstimate: null, revenueActual: null, epsActual: null }, NOW);
    upsertCalendarRow(db, row(), NOW, TODAY);
    expect(all(db)[0]!.timingConflict).toBe('Nasdaq says BMO, Finnhub says AMC');
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
  test('reportsForSnapshot: reports in the window without a final snapshot', () => {
    upsertCalendarRow(db, row({ symbol: 'PAST', reportDate: '2026-10-14' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'TODAY', reportDate: TODAY }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'PROV', reportDate: '2026-10-16' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'FINAL', reportDate: '2026-10-16' }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'FAR', reportDate: '2026-11-30' }), NOW, TODAY);
    const id = (s: string) => all(db).find((r) => r.symbol === s)!.id;
    const em = { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false };
    saveExpectedMove(db, id('PROV'), { ...em, provisional: true, quoteDate: '2026-10-14' }, NOW);
    saveExpectedMove(db, id('FINAL'), { ...em, provisional: false, quoteDate: '2026-10-15' }, NOW);
    expect(reportsForSnapshot(db, TODAY, '2026-10-22').map((r) => r.symbol).sort()).toEqual(['PROV', 'TODAY']);
  });
  test('source status keeps last success and last error', () => {
    recordSourceSuccess(db, 'nasdaq', NOW);
    recordSourceError(db, 'nasdaq', 'HTTP 403', '2026-10-15T21:00:00.000Z');
    expect(listSourceStatus(db)).toEqual([
      { source: 'nasdaq', lastSuccessAt: NOW, lastError: 'HTTP 403', lastErrorAt: '2026-10-15T21:00:00.000Z', state: null, blockedUntil: null },
    ]);
  });
  test('backfill progress', () => {
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(false);
    markBackfilled(db, 'nasdaq:2026-10-01', NOW);
    expect(isBackfilled(db, 'nasdaq:2026-10-01')).toBe(true);
  });
});

describe('schema migration', () => {
  test('an existing database gains columns added later', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'earn-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE reports (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, symbol_key TEXT NOT NULL, name TEXT NOT NULL,
      fiscal_quarter TEXT NOT NULL, report_date TEXT NOT NULL, timing TEXT NOT NULL DEFAULT 'UNKNOWN', UNIQUE (symbol_key, fiscal_quarter));
      CREATE TABLE expected_moves (report_id INTEGER PRIMARY KEY, expiry TEXT NOT NULL, strike REAL NOT NULL, call_mid REAL NOT NULL,
      put_mid REAL NOT NULL, underlying REAL NOT NULL, move_pct REAL NOT NULL, illiquid INTEGER NOT NULL, snapshot_at TEXT NOT NULL);`);
    old.close();
    const migrated = openDb(path);
    upsertCalendarRow(migrated, row(), NOW, TODAY);
    expect(all(migrated)[0]).toMatchObject({ symbol: 'SCHW', prevMovePct: null, lastYearEps: null });
    migrated.close();
  });
});

describe('reportsNeedingPrevMove order', () => {
  test('nearest date first, then largest company', () => {
    upsertCalendarRow(db, row({ symbol: 'LATE', reportDate: '2026-10-20', marketCap: 9e11 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'SMALL', reportDate: '2026-10-16', marketCap: 1e9 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BIG', reportDate: '2026-10-16', marketCap: 5e11 }), NOW, TODAY);
    expect(reportsNeedingPrevMove(db, '2026-10-15', '2026-10-30', NOW).map((r) => r.symbol)).toEqual(['BIG', 'SMALL', 'LATE']);
  });
});

describe('mergeYahooFill', () => {
  test('fills only empty fields and records the revenue currency', () => {
    upsertCalendarRow(db, row({ symbol: 'TSM', reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }), NOW, TODAY);
    const id = all(db)[0]!.id;
    mergeYahooFill(db, id, { epsActual: 4.31, revenueEstimate: 1.2e12, revenueActual: 1.27e12, revenueCurrency: 'TWD' }, NOW);
    expect(all(db)[0]).toMatchObject({ epsActual: 4.31, revenueEstimate: 1.2e12, revenueActual: 1.27e12, revenueCurrency: 'TWD' });
    mergeYahooFill(db, id, { epsActual: 9, revenueEstimate: 9, revenueActual: 9, revenueCurrency: 'TWD' }, NOW);
    expect(all(db)[0]).toMatchObject({ epsActual: 4.31, revenueActual: 1.27e12 });
  });
  test('a later confirmed Nasdaq actual wins and the difference is flagged', () => {
    upsertCalendarRow(db, row({ symbol: 'TSM', reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026' }), NOW, TODAY);
    const id = all(db)[0]!.id;
    mergeYahooFill(db, id, { epsActual: 4.31, revenueEstimate: null, revenueActual: null, revenueCurrency: null }, NOW);
    upsertCalendarRow(db, row({ symbol: 'TSM', reportDate: '2026-07-16', fiscalQuarter: 'Jun/2026', epsActual: 4.35, epsSurprisePct: 1 }), NOW, TODAY);
    expect(all(db)[0]).toMatchObject({ epsActual: 4.35, epsConflict: 'Nasdaq reports EPS 4.35, Yahoo 4.31 (often adjusted vs GAAP)' });
  });
});

describe('revenue currency guard', () => {
  test('Finnhub (USD) never writes revenue into a row held in another currency', () => {
    upsertCalendarRow(db, row({ symbol: 'ASML', reportDate: '2026-10-14', fiscalQuarter: 'Sep/2026' }), NOW, TODAY);
    const id = all(db)[0]!.id;
    mergeYahooFill(db, id, { epsActual: null, revenueEstimate: null, revenueActual: 1.1662e10, revenueCurrency: 'EUR' }, NOW);
    mergeFinnhubRow(db, { symbol: 'ASML', reportDate: '2026-10-14', timing: 'BMO', revenueEstimate: 1.3e10, revenueActual: 1.36e10, epsActual: null }, NOW);
    expect(all(db)[0]).toMatchObject({ revenueEstimate: null, revenueActual: 1.1662e10, revenueCurrency: 'EUR' });
  });
});

describe('liveSymbols', () => {
  test('reporters in the window, nearest date first then largest, capped', () => {
    upsertCalendarRow(db, row({ symbol: 'LATE', reportDate: '2026-10-16', marketCap: 9e11 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'BIG', reportDate: TODAY, marketCap: 5e11 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'SMALL', reportDate: TODAY, marketCap: 1e9 }), NOW, TODAY);
    upsertCalendarRow(db, row({ symbol: 'FAR', reportDate: '2026-10-30', marketCap: 1e12 }), NOW, TODAY);
    expect(liveSymbols(db, TODAY, '2026-10-16', 3)).toEqual(['BIG', 'SMALL', 'LATE']);
    expect(liveSymbols(db, TODAY, '2026-10-16', 2)).toEqual(['BIG', 'SMALL']);
  });
});
