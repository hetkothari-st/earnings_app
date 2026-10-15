import { describe, expect, test, vi } from 'vitest';
import { listRange, listSourceStatus, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { backfill } from '../../src/jobs/backfill.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { refreshCalendar } from '../../src/jobs/refreshCalendar.js';
import { refreshResults } from '../../src/jobs/refreshResults.js';
import { secSync } from '../../src/jobs/secSync.js';
import { snapshotMoves } from '../../src/jobs/snapshotMoves.js';
import { SourceFormatError } from '../../src/sources/http.js';
import type { CalendarRow, OptionChain } from '../../src/types.js';

const NOW = '2026-10-15T20:30:00.000Z';
const TODAY = '2026-10-15'; // Thursday

function makeCtx(over: Partial<Sources> = {}): JobContext {
  const sources: Sources = {
    calendar: async () => [],
    earningsDetails: async () => [],
    optionChain: async () => null,
    secTickers: async () => new Map(),
    secEarningsFilings: async () => [],
    secAcceptance: async () => '',
    ...over,
  };
  return { db: openDb(':memory:'), sources, now: () => NOW, today: () => TODAY };
}

const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: TODAY, fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.6e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null, ...over,
});
const all = (ctx: JobContext) => listRange(ctx.db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null });

describe('refreshCalendar', () => {
  test('fetches weekdays only and stores rows', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal()] : []));
    const ctx = makeCtx({ calendar });
    await refreshCalendar(ctx, 3); // Thu..Sun
    expect(calendar.mock.calls.map((c) => c[0])).toEqual(['2026-10-15', '2026-10-16']);
    expect(all(ctx)).toHaveLength(1);
    expect(listSourceStatus(ctx.db)[0]).toMatchObject({ source: 'nasdaq', lastSuccessAt: NOW, lastError: null });
  });
  test('format error records status and keeps stored data', async () => {
    const ctx = makeCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    ctx.sources.calendar = async () => { throw new SourceFormatError('Nasdaq calendar: bad shape'); };
    await refreshCalendar(ctx, 0);
    expect(all(ctx)[0]).toMatchObject({ symbol: 'SCHW', timing: 'BMO', marketCap: 1.6e11 });
    expect(listSourceStatus(ctx.db)[0]).toMatchObject({ source: 'nasdaq', lastError: 'Nasdaq calendar: bad shape', lastErrorAt: NOW });
  });
});

describe('refreshResults', () => {
  test('re-reads previous and current day and merges Finnhub revenue', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal({ epsActual: 1.71, epsSurprisePct: 3 })] : []));
    const earningsDetails = vi.fn(async () => [
      { symbol: 'SCHW', reportDate: TODAY, timing: 'BMO' as const, revenueEstimate: 6.0e9, revenueActual: 6.2e9 },
    ]);
    const ctx = makeCtx({ calendar, earningsDetails });
    await refreshResults(ctx);
    expect(calendar.mock.calls.map((c) => c[0])).toEqual(['2026-10-14', '2026-10-15']);
    expect(earningsDetails).toHaveBeenCalledWith('2026-10-14', '2026-10-15');
    expect(all(ctx)[0]).toMatchObject({ epsActual: 1.71, revenueActual: 6.2e9 });
  });
});

describe('snapshotMoves', () => {
  test('computes for AMC today and BMO next trading day', async () => {
    const chain: OptionChain = {
      underlying: 100,
      quotes: [
        { expiry: '2026-10-16', type: 'C', strike: 100, bid: 2.9, ask: 3.1 },
        { expiry: '2026-10-16', type: 'P', strike: 100, bid: 2.9, ask: 3.1 },
      ],
    };
    const optionChain = vi.fn(async () => chain);
    const ctx = makeCtx({ optionChain });
    upsertCalendarRow(ctx.db, cal({ symbol: 'AMCT', timing: 'AMC' }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'BMON', reportDate: '2026-10-16' }), NOW, TODAY);
    await snapshotMoves(ctx);
    const rows = all(ctx);
    expect(rows.find((r) => r.symbol === 'BMON')?.expectedMove).toMatchObject({ movePct: 6, expiry: '2026-10-16', snapshotAt: NOW });
    // AMC on 10-15 needs an expiry after 10-15: 10-16 qualifies
    expect(rows.find((r) => r.symbol === 'AMCT')?.expectedMove?.movePct).toBe(6);
  });
  test('no options -> no snapshot, no crash', async () => {
    const ctx = makeCtx({ optionChain: async () => null });
    upsertCalendarRow(ctx.db, cal({ timing: 'AMC' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toBeNull();
  });
});

describe('secSync', () => {
  const tickers = new Map([
    ['JPM', { cik: 19617, exchange: 'NYSE' }],
    ['BRK-B', { cik: 1067983, exchange: 'NYSE' }],
  ]);
  const filing = {
    accession: '0001628280-26-065582', filingDate: '2026-10-13',
    docUrl: 'https://www.sec.gov/doc.htm', indexUrl: 'https://www.sec.gov/index.htm',
  };

  test('verifies BMO from the header acceptance time and stores links', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => '2026-10-13T06:30:38',
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]).toMatchObject({
      exchange: 'NYSE', secCheck: 'verified', timing: 'BMO', secAcceptedAt: '2026-10-13T06:30:38',
      secDocUrl: filing.docUrl, secIndexUrl: filing.indexUrl,
    });
  });
  test('derives BMO for unknown timing and marks the source as sec', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => '2026-10-13T06:30:38',
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'UNKNOWN' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]).toMatchObject({ timing: 'BMO', timingSource: 'sec', secCheck: 'derived' });
  });
  test('sets exchange for class-share ticker', async () => {
    const ctx = makeCtx({ secTickers: async () => tickers });
    upsertCalendarRow(ctx.db, cal({ symbol: 'BRK/B', reportDate: '2026-10-20' }), NOW, TODAY);
    await secSync(ctx);
    expect(all(ctx)[0]!.exchange).toBe('NYSE');
  });
  test('a failed header fetch leaves the report pending for the next run', async () => {
    const ctx = makeCtx({
      secTickers: async () => tickers,
      secEarningsFilings: async () => [filing],
      secAcceptance: async () => { throw new Error('HTTP 503'); },
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'BMO' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]!.secCheck).toBeNull();
  });
  test('ticker unknown to SEC -> unverifiable', async () => {
    const ctx = makeCtx({ secTickers: async () => new Map() });
    upsertCalendarRow(ctx.db, cal({ symbol: 'ZZZZ', reportDate: '2026-10-13' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]!.secCheck).toBe('unverifiable');
  });
});

describe('backfill', () => {
  test('is resumable: completed days are not fetched again', async () => {
    const calendar = vi.fn(async (date: string) => [cal({ symbol: `S${date.slice(8)}`, reportDate: date, fiscalQuarter: `q${date}` })]);
    const ctx = makeCtx({ calendar });
    await backfill(ctx, '2026-10-12', () => {});
    const first = calendar.mock.calls.length;
    expect(first).toBe(3); // Mon 12, Tue 13, Wed 14 (today excluded)
    await backfill(ctx, '2026-10-12', () => {});
    expect(calendar.mock.calls.length).toBe(first);
    expect(all(ctx)).toHaveLength(3);
  });
});
