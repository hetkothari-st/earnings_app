import { describe, expect, test, vi } from 'vitest';
import { listRange, listSourceStatus, openDb, setSecResult, upsertCalendarRow } from '../../src/db/repo.js';
import { backfill } from '../../src/jobs/backfill.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { refreshCalendar } from '../../src/jobs/refreshCalendar.js';
import { computePrevMoves } from '../../src/jobs/prevMoves.js';
import { refreshSectors } from '../../src/jobs/sectors.js';
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
    dailyCloses: async () => new Map(),
    sectors: async () => new Map(),
    ...over,
  };
  return { db: openDb(':memory:'), sources, now: () => NOW, today: () => TODAY };
}

const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: TODAY, fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.6e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});
const all = (ctx: JobContext) => listRange(ctx.db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null });

describe('review fixes', () => {
  test('calendar refresh also merges Finnhub revenue for the next two weeks', async () => {
    const earningsDetails = vi.fn(async () => [
      { symbol: 'SCHW', reportDate: '2026-10-16', timing: 'BMO' as const, revenueEstimate: 6e9, revenueActual: null, epsActual: null },
    ]);
    const ctx = makeCtx({ calendar: async (d) => (d === '2026-10-16' ? [cal({ reportDate: d })] : []), earningsDetails });
    await refreshCalendar(ctx, 1);
    expect(earningsDetails).toHaveBeenCalledWith('2026-10-15', '2026-10-29');
    expect(all(ctx)[0]!.revenueEstimate).toBe(6e9);
  });
  const chainAsOf = (asOfDate: string): OptionChain => ({
    underlying: 100, asOfDate,
    quotes: [
      { expiry: '2026-10-16', type: 'C', strike: 100, bid: 2.9, ask: 3.1 },
      { expiry: '2026-10-16', type: 'P', strike: 100, bid: 2.9, ask: 3.1 },
      { expiry: '2026-10-23', type: 'C', strike: 100, bid: 4.4, ask: 4.6 },
      { expiry: '2026-10-23', type: 'P', strike: 100, bid: 4.4, ask: 4.6 },
    ],
  });
  test('BMO today priced off yesterday close is final (the last close before the release)', async () => {
    const ctx = makeCtx({ optionChain: async () => chainAsOf('2026-10-14') });
    upsertCalendarRow(ctx.db, cal({ timing: 'BMO' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toMatchObject({ movePct: 6, provisional: false, quoteDate: '2026-10-14' });
  });
  test('quotes from after the release are never used', async () => {
    const ctx = makeCtx({ optionChain: async () => chainAsOf('2026-10-15') });
    upsertCalendarRow(ctx.db, cal({ timing: 'BMO' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toBeNull();
  });
  test('an earlier close gives a provisional value, replaced by the final one, which is never overwritten', async () => {
    let asOf = '2026-10-14';
    const ctx = makeCtx({ optionChain: async () => chainAsOf(asOf) });
    upsertCalendarRow(ctx.db, cal({ timing: 'AMC' }), NOW, TODAY); // AMC today: final needs today's close
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toMatchObject({ provisional: true, quoteDate: '2026-10-14' });
    asOf = '2026-10-15';
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toMatchObject({ provisional: false, quoteDate: '2026-10-15' });
    asOf = '2026-10-16';
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove).toMatchObject({ provisional: false, quoteDate: '2026-10-15' });
  });
  test('any failed header fetch leaves the report pending, even if another candidate succeeded', async () => {
    const f = (accession: string) => ({ accession, filingDate: '2026-10-13', docUrl: 'd', indexUrl: 'i' });
    const ctx = makeCtx({
      secTickers: async () => new Map([['JPM', { cik: 19617, exchange: 'NYSE' }]]),
      secEarningsFilings: async () => [f('a'), f('b')],
      secAcceptance: async (_cik, acc) => { if (acc === 'a') throw new Error('HTTP 503'); return '2026-10-13T16:30:00'; },
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'JPM', reportDate: '2026-10-13', timing: 'AMC' }), NOW, '2026-10-12');
    await secSync(ctx);
    expect(all(ctx)[0]!.secCheck).toBeNull();
  });
});

describe('refreshCalendar', () => {
  test('fetches weekdays only and stores rows', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal()] : []));
    const ctx = makeCtx({ calendar });
    await refreshCalendar(ctx, 3); // Thu..Sun
    expect(calendar.mock.calls.map((c) => c[0])).toEqual(['2026-10-15', '2026-10-16']);
    expect(all(ctx)).toHaveLength(1);
    expect(listSourceStatus(ctx.db).find((x) => x.source === 'nasdaq')).toMatchObject({ source: 'nasdaq', lastSuccessAt: NOW, lastError: null });
  });
  test('format error records status and keeps stored data', async () => {
    const ctx = makeCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    ctx.sources.calendar = async () => { throw new SourceFormatError('Nasdaq calendar: bad shape'); };
    await refreshCalendar(ctx, 0);
    expect(all(ctx)[0]).toMatchObject({ symbol: 'SCHW', timing: 'BMO', marketCap: 1.6e11 });
    expect(listSourceStatus(ctx.db).find((x) => x.source === 'nasdaq')).toMatchObject({ source: 'nasdaq', lastError: 'Nasdaq calendar: bad shape', lastErrorAt: NOW });
  });
});

describe('refreshResults', () => {
  test('re-reads previous and current day and merges Finnhub revenue', async () => {
    const calendar = vi.fn(async (date: string) => (date === TODAY ? [cal({ epsActual: 1.71, epsSurprisePct: 3 })] : []));
    const earningsDetails = vi.fn(async () => [
      { symbol: 'SCHW', reportDate: TODAY, timing: 'BMO' as const, revenueEstimate: 6.0e9, revenueActual: 6.2e9, epsActual: null },
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
      underlying: 100, asOfDate: TODAY,
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

describe('previous move', () => {
  test('uses the last report before this one and its timing', async () => {
    const dailyCloses = vi.fn(async () => new Map([['2026-07-13', 100], ['2026-07-14', 97.5], ['2026-07-15', 102.4]]));
    const ctx = makeCtx({ dailyCloses });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-14', fiscalQuarter: 'Jun/2026', timing: 'AMC' }), NOW, '2026-07-01');
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026' }), NOW, TODAY);
    await computePrevMoves(ctx);
    const next = all(ctx).find((r) => r.reportDate === '2026-10-16')!;
    expect(next).toMatchObject({ prevMovePct: 5, prevMoveDate: '2026-07-14' });
    expect(dailyCloses).toHaveBeenCalledWith('SCHW', '2026-07-04', '2026-07-24');
  });
  const closes = new Map([['2026-07-13', 100], ['2026-07-14', 97.5], ['2026-07-15', 102.4]]);
  test('known previous timing gives an exact move', async () => {
    const ctx = makeCtx({ dailyCloses: async () => closes });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-14', fiscalQuarter: 'Jun/2026', timing: 'BMO' }), NOW, '2026-07-01');
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'AMC' }), NOW, TODAY);
    await computePrevMoves(ctx);
    expect(all(ctx).find((r) => r.reportDate === '2026-10-16')).toMatchObject({ prevMovePct: -2.5, prevMoveBasis: 'known' });
  });
  test('unknown previous timing with an SEC filing after that close is treated as AMC, marked inferred', async () => {
    const ctx = makeCtx({ dailyCloses: async () => closes });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-14', fiscalQuarter: 'Jun/2026', timing: 'UNKNOWN' }), NOW, '2026-07-01');
    const prevId = all(ctx)[0]!.id;
    setSecResult(ctx.db, prevId, { check: 'unverifiable', timing: 'UNKNOWN', timingSource: null, acceptedAt: '2026-07-14T16:12:00', docUrl: null, indexUrl: null }, NOW);
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'BMO' }), NOW, TODAY);
    await computePrevMoves(ctx);
    expect(all(ctx).find((r) => r.reportDate === '2026-10-16')).toMatchObject({ prevMovePct: 5, prevMoveBasis: 'sec-inferred' });
  });
  test('otherwise the current quarter timing is assumed, marked assumed', async () => {
    const ctx = makeCtx({ dailyCloses: async () => closes });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-14', fiscalQuarter: 'Jun/2026', timing: 'UNKNOWN' }), NOW, '2026-07-01');
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'BMO' }), NOW, TODAY);
    await computePrevMoves(ctx);
    expect(all(ctx).find((r) => r.reportDate === '2026-10-16')).toMatchObject({ prevMovePct: -2.5, prevMoveBasis: 'assumed' });
  });
  test('no timing anywhere gives no move', async () => {
    const ctx = makeCtx({ dailyCloses: async () => closes });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-14', fiscalQuarter: 'Jun/2026', timing: 'UNKNOWN' }), NOW, '2026-07-01');
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16', fiscalQuarter: 'Sep/2026', timing: 'UNKNOWN' }), NOW, TODAY);
    await computePrevMoves(ctx);
    expect(all(ctx).find((r) => r.reportDate === '2026-10-16')).toMatchObject({ prevMovePct: null, prevMoveDate: '2026-07-14' });
  });
  test('snapshot stores options volume', async () => {
    const chain: OptionChain = { underlying: 100, asOfDate: TODAY, totalVolume: 29599, quotes: [
      { expiry: '2026-10-16', type: 'C', strike: 100, bid: 2.9, ask: 3.1 },
      { expiry: '2026-10-16', type: 'P', strike: 100, bid: 2.9, ask: 3.1 },
    ] };
    const ctx = makeCtx({ optionChain: async () => chain });
    upsertCalendarRow(ctx.db, cal({ timing: 'AMC' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(all(ctx)[0]!.expectedMove?.optionsVolume).toBe(29599);
  });
});

describe('sectors', () => {
  test('sector and industry are set for every row of a symbol', async () => {
    const ctx = makeCtx({ sectors: async () => new Map([['SCHW', { sector: 'Finance', industry: 'Investment Bankers/Brokers/Service' }]]) });
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    await refreshSectors(ctx);
    expect(all(ctx)[0]).toMatchObject({ sector: 'Finance', industry: 'Investment Bankers/Brokers/Service' });
  });
});
