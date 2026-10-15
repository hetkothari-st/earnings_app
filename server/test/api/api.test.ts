import { beforeEach, describe, expect, test } from 'vitest';
import { toDto } from '../../src/api/dto.js';
import { buildServer } from '../../src/api/server.js';
import {
  type Db, listRange, mergeFinnhubRow, openDb, recordSourceSuccess, saveExpectedMove, setSecResult, upsertCalendarRow,
} from '../../src/db/repo.js';
import type { CalendarRow } from '../../src/types.js';

const NOW = '2026-10-15T20:00:00.000Z';
const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-15', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.659e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: 1.71, epsSurprisePct: 3,
  lastYearEps: 1.31, lastYearReportDate: '2025-10-16', ...over,
});

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('toDto', () => {
  test('maps results with beat/miss and revenue surprise', () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-15', timing: 'BMO', revenueEstimate: 6e9, revenueActual: 5.7e9, epsActual: null }, NOW);
    const dto = toDto(listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!);
    expect(dto.eps).toEqual({ estimate: 1.66, actual: 1.71, surprisePct: 3, result: 'beat', noOfEsts: 10, lastYear: 1.31, lastYearReportDate: '2025-10-16' });
    expect(dto.revenue).toEqual({ estimate: 6e9, actual: 5.7e9, surprisePct: -5, result: 'miss' });
    expect(dto.sessionClose).toBe('16:00');
    expect(dto.flags).toEqual([]);
  });
  test('flags: unknown time, backfilled market cap, illiquid, SEC contradiction, timing conflict', () => {
    upsertCalendarRow(db, cal({ timing: 'UNKNOWN', reportDate: '2026-10-13' }), NOW, '2026-10-15');
    const r0 = listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!;
    saveExpectedMove(db, r0.id, { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: true }, NOW);
    const messages = toDto(listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!).flags.map((f) => f.message);
    expect(messages).toEqual([
      'Time not announced',
      'Market cap is current, not at report time',
      'Illiquid options: zero bid or spread over 30% of mid',
    ]);

    setSecResult(db, r0.id, { check: 'contradicted', timing: 'AMC', timingSource: 'nasdaq', acceptedAt: '2026-10-13T06:30:38', docUrl: null, indexUrl: null }, NOW);
    const flags = toDto(listRange(db, { from: '2026-10-13', to: '2026-10-13', minCap: null, q: null })[0]!).flags;
    expect(flags[0]).toEqual({ field: 'timing', message: 'SEC 8-K accepted 6:30 AM ET, which contradicts AMC' });
  });
});

describe('EPS surprise and conflicts', () => {
  test('surprise is computed from the stored actual and estimate, and a conflict is flagged', () => {
    upsertCalendarRow(db, cal({ epsActual: 1.65, epsSurprisePct: -0.6 }), NOW, '2026-10-15');
    mergeFinnhubRow(db, { symbol: 'SCHW', reportDate: '2026-10-15', timing: 'BMO', revenueEstimate: null, revenueActual: null, epsActual: 1.71 }, NOW);
    const dto = toDto(listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!);
    expect(dto.eps).toMatchObject({ actual: 1.65, surprisePct: -0.6, result: 'miss' });
    expect(dto.flags).toContainEqual({ field: 'eps', message: 'Nasdaq reports EPS 1.65, Finnhub 1.71 (often adjusted vs GAAP)' });
  });
});

describe('live move in DTO', () => {
  test('change is measured against the expected move at the last close', () => {
    upsertCalendarRow(db, cal({ timing: 'AMC' }), NOW, '2026-10-15');
    const r = listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!;
    const em = { expiry: '2026-10-16', strike: 100, callMid: 2, putMid: 1.8, underlying: 100, movePct: 3.8, illiquid: false, snapshotAt: NOW, provisional: true, quoteDate: '2026-10-14' };
    const dto = toDto({ ...r, expectedMove: em, liveMove: { movePct: 4.1, illiquid: false, quoteTime: '2026-10-15T11:03:00', fetchedAt: NOW } });
    expect(dto.liveMove).toEqual({ movePct: 4.1, changePp: 0.3, illiquid: false, quoteTime: '2026-10-15T11:03:00' });
    expect(toDto({ ...r, expectedMove: null, liveMove: { movePct: 4.1, illiquid: false, quoteTime: 'x', fetchedAt: NOW } }).liveMove?.changePp).toBeNull();
  });
});

describe('expected-move guard', () => {
  test('a snapshot whose expiry no longer fits the timing is not shown', () => {
    upsertCalendarRow(db, cal({ timing: 'AMC', reportDate: '2026-10-16' }), NOW, '2026-10-15');
    const r = listRange(db, { from: '2026-10-16', to: '2026-10-16', minCap: null, q: null })[0]!;
    // expiry on the report date is valid for BMO only
    expect(toDto({ ...r, expectedMove: { expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false, snapshotAt: NOW } }).expectedMove).toBeNull();
  });
});

describe('routes', () => {
  test('GET /api/earnings returns rows and source status', async () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    recordSourceSuccess(db, 'nasdaq', NOW);
    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/api/earnings?from=2026-10-15&to=2026-10-15&minCap=2000000000' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.map((r: { symbol: string }) => r.symbol)).toEqual(['SCHW']);
    expect(body.sources[0]).toMatchObject({ source: 'nasdaq', lastSuccessAt: NOW });
  });
  test.each([
    'from=2026-10-15',
    'from=2026-10-16&to=2026-10-15',
    'from=2026-02-31&to=2026-03-01',
    'from=2024-01-01&to=2026-01-01',
    'from=2026-10-15&to=2026-10-15&minCap=abc',
  ])('400 for bad query %s', async (qs) => {
    const res = await buildServer(db).inject({ method: 'GET', url: `/api/earnings?${qs}` });
    expect(res.statusCode).toBe(400);
  });
  test('GET /api/earnings/:id 404 for unknown id', async () => {
    const res = await buildServer(db).inject({ method: 'GET', url: '/api/earnings/999' });
    expect(res.statusCode).toBe(404);
  });
  test('GET /api/status returns counts', async () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    const res = await buildServer(db).inject({ method: 'GET', url: '/api/status' });
    expect(res.json().counts).toEqual({ reports: 1, withExpectedMove: 0, secVerified: 0 });
  });
});

describe('markets', () => {
  test('GET /api/markets returns the five indices, cached between calls', async () => {
    let calls = 0;
    const quote = (symbol: string) => ({ symbol, price: 100, previousClose: 99, changePct: 1.01, asOf: NOW, currency: 'USD' });
    const app = buildServer(db, { indexQuote: async (s) => { calls++; return quote(s); } });
    const first = (await app.inject({ method: 'GET', url: '/api/markets' })).json();
    await app.inject({ method: 'GET', url: '/api/markets' });
    expect(first.indices.map((i: { exchange: string }) => i.exchange)).toEqual(['NYSE', 'Nasdaq', 'Shanghai', 'Japan Exchange', 'Euronext']);
    expect(first.indices[0]).toMatchObject({ index: 'S&P 500', price: 100, changePct: 1.01 });
    expect(calls).toBe(5);
  });
  test('one failed index shows as unavailable, others still load', async () => {
    const app = buildServer(db, { indexQuote: async (s) => {
      if (s === '^N225') throw new Error('HTTP 500');
      return { symbol: s, price: 1, previousClose: 1, changePct: 0, asOf: NOW, currency: null };
    } });
    const body = (await app.inject({ method: 'GET', url: '/api/markets' })).json();
    expect(body.indices.find((i: { exchange: string }) => i.exchange === 'Japan Exchange')).toMatchObject({ price: null });
  });
});

describe('previous move in DTO', () => {
  test('carries the move and the report date it came from', () => {
    upsertCalendarRow(db, cal(), NOW, '2026-10-15');
    const r = listRange(db, { from: '2026-10-15', to: '2026-10-15', minCap: null, q: null })[0]!;
    expect(toDto({ ...r, prevMovePct: -2.5, prevMoveDate: '2026-07-16', prevMoveBasis: 'sec-inferred' }).previousMove)
      .toEqual({ pct: -2.5, reportDate: '2026-07-16', basis: 'sec-inferred' });
    expect(toDto({ ...r, prevMovePct: null, prevMoveDate: null }).previousMove).toBeNull();
  });
});
