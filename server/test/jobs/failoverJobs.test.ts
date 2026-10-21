import { describe, expect, test, vi } from 'vitest';
import { listSourceStatus, openDb, setEstimatedDate, upsertCalendarRow } from '../../src/db/repo.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { refreshCalendar, storeCalendarRows } from '../../src/jobs/refreshCalendar.js';
import { refreshSectors } from '../../src/jobs/sectors.js';
import { snapshotMoves } from '../../src/jobs/snapshotMoves.js';
import { HttpError } from '../../src/sources/http.js';
import type { CalendarRow, OptionChain } from '../../src/types.js';

const NOW = '2026-10-15T20:30:00.000Z';
const TODAY = '2026-10-15';

function makeCtx(over: Partial<Sources> = {}): JobContext {
  const sources: Sources = {
    calendar: async () => [], earningsDetails: async () => [], optionChain: async () => null,
    secTickers: async () => new Map(), secEarningsFilings: async () => [], secAcceptance: async () => '',
    dailyCloses: async () => new Map(), sectors: async () => new Map(), yahooSummary: async () => null, ...over,
  };
  return { db: openDb(':memory:'), sources, now: () => NOW, today: () => TODAY };
}
const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'SCHW', name: 'Charles Schwab', reportDate: '2026-10-20', fiscalQuarter: 'Sep/2026', timing: 'BMO',
  marketCap: 1.6e11, epsEstimate: 1.66, noOfEsts: 10, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});
const summary = (nextEarningsDate?: string) => ({
  priceCurrency: 'USD', financialCurrency: 'USD', epsHistory: [], revenueQuarters: [], revenueEstimates: [],
  ...(nextEarningsDate ? { nextEarningsDate } : {}),
});
const dates = (ctx: JobContext) => ctx.db.prepare('SELECT symbol, report_date AS d, date_status AS s, timing, rescheduled_from AS rf FROM reports ORDER BY symbol').all();
const estimate = (ctx: JobContext) => ctx.db.prepare("UPDATE reports SET date_status = 'estimated'").run();
const status = (ctx: JobContext, source: string) => listSourceStatus(ctx.db).find((x) => x.source === source);

describe('Nasdaq calendar with a Yahoo backup', () => {
  test('Nasdaq blocked: calendar falls back to Yahoo estimated dates', async () => {
    const yahooSummary = vi.fn(async () => summary('2026-10-22'));
    const ctx = makeCtx({ calendar: async () => { throw new HttpError(429, 'https://api.nasdaq.com'); }, yahooSummary });
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    estimate(ctx); // only a date that is itself an estimate may be adjusted by Yahoo
    await refreshCalendar(ctx, 14);
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-22', s: 'estimated', timing: 'UNKNOWN', rf: null }]);
    expect(status(ctx, 'nasdaq')).toMatchObject({ state: 'backup' });
    expect(status(ctx, 'nasdaq')!.blockedUntil).toBe('2026-10-15T20:31:00.000Z'); // 1 minute back-off
    // While blocked, the next run does not call Nasdaq at all.
    const calendar = vi.fn(async () => []);
    ctx.sources.calendar = calendar;
    await refreshCalendar(ctx, 14);
    expect(calendar).not.toHaveBeenCalled();
  });

  test('a 200 block page (HTML instead of JSON) counts as blocked too', async () => {
    const ctx = makeCtx({ calendar: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, yahooSummary: async () => summary('2026-10-21') });
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    estimate(ctx);
    await refreshCalendar(ctx, 14);
    expect(status(ctx, 'nasdaq')).toMatchObject({ state: 'backup', blockedUntil: expect.any(String) });
  });

  test('Yahoo never touches a released report, a date in the past, or a range of dates', async () => {
    const ctx = makeCtx({ calendar: async () => { throw new HttpError(403, 'u'); } });
    upsertCalendarRow(ctx.db, cal({ symbol: 'AAA', epsActual: 1.2 }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'BBB' }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'CCC' }), NOW, TODAY);
    ctx.sources.yahooSummary = async (s) => (s === 'AAA' ? summary('2026-10-22') : s === 'BBB' ? summary('2026-10-01') : summary());
    await refreshCalendar(ctx, 14);
    expect(dates(ctx).map((r) => (r as { d: string; s: string | null }).s)).toEqual([null, null, null]);
  });

  test('Nasdaq listing the symbol again confirms the date', async () => {
    const ctx = makeCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    ctx.db.prepare("UPDATE reports SET date_status = 'estimated'").run();
    storeCalendarRows(ctx, [cal()]);
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-20', s: null, timing: 'BMO', rf: null }]);
  });

  test('Nasdaq working: Yahoo is not asked and the status is ok', async () => {
    const yahooSummary = vi.fn(async () => summary('2026-10-22'));
    const ctx = makeCtx({ calendar: async (d) => (d === '2026-10-20' ? [cal()] : []), yahooSummary });
    await refreshCalendar(ctx, 6);
    expect(yahooSummary).not.toHaveBeenCalled();
    expect(status(ctx, 'nasdaq')).toMatchObject({ state: 'ok', lastSuccessAt: NOW });
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-20', s: null, timing: 'BMO', rf: null }]);
  });

  test('one transient Nasdaq error on one date: Yahoo leaves the date Nasdaq stored alone', async () => {
    const ctx = makeCtx({
      calendar: async (d) => { if (d === '2026-10-16') throw new Error('timeout'); return d === '2026-10-20' ? [cal()] : []; },
      yahooSummary: async () => summary('2026-10-22'),
    });
    await refreshCalendar(ctx, 14);
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-20', s: null, timing: 'BMO', rf: null }]);
  });

  test('a Nasdaq-confirmed date is not moved by Yahoo while Nasdaq is blocked', async () => {
    const ctx = makeCtx({ calendar: async () => { throw new HttpError(429, 'u'); }, yahooSummary: async () => summary('2026-10-22') });
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    await refreshCalendar(ctx, 14);
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-20', s: null, timing: 'BMO', rf: null }]);
  });

  test('a Yahoo date more than 14 days from the stored one, or outside the window, is ignored', async () => {
    for (const [yahoo, expected] of [['2026-11-20', '2026-10-20'], ['2026-10-30', '2026-10-20'], ['2026-10-27', '2026-10-27']] as const) {
      const ctx = makeCtx({ calendar: async () => { throw new HttpError(429, 'u'); }, yahooSummary: async () => summary(yahoo) });
      upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
      estimate(ctx);
      await refreshCalendar(ctx, 14);
      expect((dates(ctx)[0] as { d: string }).d, yahoo).toBe(expected);
    }
  });

  test('D1 -> Yahoo D2 -> Nasdaq D1 is a correction, not a reschedule', () => {
    const ctx = makeCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    const id = (ctx.db.prepare('SELECT id FROM reports').get() as { id: number }).id;
    setEstimatedDate(ctx.db, id, '2026-10-22');
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-22', s: 'estimated', timing: 'UNKNOWN', rf: null }]);
    storeCalendarRows(ctx, [cal()]);
    expect(dates(ctx)).toEqual([{ symbol: 'SCHW', d: '2026-10-20', s: null, timing: 'BMO', rf: null }]);
  });

  test("one symbol's Yahoo error does not abort the backup run", async () => {
    const ctx = makeCtx({
      calendar: async () => { throw new HttpError(429, 'u'); },
      yahooSummary: async (s) => { if (s === 'AAA') throw new Error('boom'); return summary('2026-10-22'); },
    });
    upsertCalendarRow(ctx.db, cal({ symbol: 'AAA', marketCap: 2e11 }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'BBB' }), NOW, TODAY);
    estimate(ctx);
    await refreshCalendar(ctx, 14);
    expect(dates(ctx).map((r) => (r as { d: string }).d)).toEqual(['2026-10-20', '2026-10-22']);
  });
});

describe('Nasdaq sectors', () => {
  test('a 200 HTML block page is recorded as blocked and backed off; stored sectors stay', async () => {
    const ctx = makeCtx({ sectors: async () => { throw new SyntaxError('Unexpected token <'); } });
    await refreshSectors(ctx);
    expect(status(ctx, 'nasdaq')).toMatchObject({ state: 'blocked', blockedUntil: '2026-10-15T20:31:00.000Z' });
  });
});

describe('Cboe', () => {
  const chain: OptionChain = { underlying: 100, asOfDate: TODAY, quotes: [] };
  test('blocked: stored values stay, Cboe is skipped for the rest of the run and backed off', async () => {
    const optionChain = vi.fn(async (): Promise<OptionChain | null> => { throw new HttpError(429, 'u'); });
    const ctx = makeCtx({ optionChain });
    upsertCalendarRow(ctx.db, cal({ symbol: 'AAA', reportDate: '2026-10-16' }), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ symbol: 'BBB', reportDate: '2026-10-16' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(optionChain).toHaveBeenCalledTimes(1);
    expect(status(ctx, 'cboe')).toMatchObject({ state: 'blocked', blockedUntil: '2026-10-15T20:31:00.000Z' });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM expected_moves').get()).toEqual({ n: 0 });
  });
  test('working: state ok', async () => {
    const ctx = makeCtx({ optionChain: async () => chain });
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-10-16' }), NOW, TODAY);
    await snapshotMoves(ctx);
    expect(status(ctx, 'cboe')).toMatchObject({ state: 'ok' });
  });
});
