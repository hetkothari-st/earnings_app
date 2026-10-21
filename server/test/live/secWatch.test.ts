import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { listRange, listSourceStatus, mergeFinnhubRow, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import type { JobContext } from '../../src/jobs/context.js';
import { SecWatch } from '../../src/live/secWatch.js';
import { HttpError } from '../../src/sources/http.js';
import type { Http } from '../../src/sources/http.js';
import type { CalendarRow } from '../../src/types.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/us/${n}`, import.meta.url), 'utf8');
const NOW = '2026-10-21T12:10:00.000Z';

const udr = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'UDR', name: 'UDR', reportDate: '2026-10-21', fiscalQuarter: 'Sep/2026', timing: 'AMC',
  marketCap: 1e10, epsEstimate: 0.6, noOfEsts: 5, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});

function setup(opts: { feed?: () => Promise<string>; row?: Partial<CalendarRow>; reader?: (u: string, id: number) => Promise<void> } = {}) {
  const db = openDb(':memory:');
  const ctx: JobContext = {
    db, now: () => NOW, today: () => '2026-10-21',
    sources: { secTickers: async () => new Map([['UDR', { cik: 74208, exchange: 'NYSE' }]]) } as unknown as JobContext['sources'],
  };
  upsertCalendarRow(db, udr(opts.row), NOW, '2026-10-21');
  const urls: string[] = [];
  const http: Http = {
    json: async () => { throw new Error('unused'); },
    text: async (u) => { urls.push(u); return u.includes('browse-edgar') ? (opts.feed ?? (async () => fx('sec_getcurrent_8k.xml')))() : fx('sec_index_udr_ex99.htm'); },
  };
  const released: number[][] = [];
  const watch = new SecWatch(ctx, http, (ids) => released.push(ids), opts.reader);
  const row = () => listRange(db, { from: '2000-01-01', to: '2100-01-01', minCap: null, q: null })[0]!;
  return { db, ctx, watch, released, row, urls };
}

describe('SecWatch', () => {
  test('a 2.02 filing flips the report: releasedAt set, timing BMO (08:05 ET), ids returned', async () => {
    const t = setup();
    const ids = await t.watch.tick();
    expect(ids).toEqual([t.row().id]);
    expect(t.row()).toMatchObject({ releasedAt: '2026-10-21T12:05:10.000Z', timing: 'BMO', timingSource: 'sec', reportDate: '2026-10-21' });
    expect(t.released).toEqual([ids]);
  });

  test('the same accession on the next tick changes nothing', async () => {
    const t = setup();
    await t.watch.tick();
    expect(await t.watch.tick()).toEqual([]);
    expect(t.released).toHaveLength(1);
  });

  test('an 8-K/A for an already released report keeps the earlier time', async () => {
    const t = setup();
    await t.watch.tick();
    const amended = fx('sec_getcurrent_8k.xml')
      .replace('0000074208-26-000081', '0000074208-26-000099').replace(/0000074208-26-000081/g, '0000074208-26-000099')
      .replace('2026-10-21T08:05:10-04:00', '2026-10-21T09:00:00-04:00').replace('term="8-K"', 'term="8-K/A"');
    (t.watch as unknown as { http: Http }).http = { json: async () => null, text: async () => amended };
    expect(await t.watch.tick()).toEqual([]);
    expect(t.row().releasedAt).toBe('2026-10-21T12:05:10.000Z');
  });

  test('filed one day after the calendar date: report_date moves, rescheduled_from set', async () => {
    const t = setup({ row: { reportDate: '2026-10-20' } });
    await t.watch.tick();
    expect(t.row()).toMatchObject({ reportDate: '2026-10-21', rescheduledFrom: '2026-10-20' });
  });

  test('no report within +-3 days: nothing changes', async () => {
    const t = setup({ row: { reportDate: '2026-10-30' } });
    expect(await t.watch.tick()).toEqual([]);
    expect(t.row()).toMatchObject({ reportDate: '2026-10-30', releasedAt: null, timing: 'AMC' });
  });

  test('feed blocked (429): tick returns [] and the source state is blocked', async () => {
    const t = setup({ feed: async () => { throw new HttpError(429, 'x'); } });
    expect(await t.watch.tick()).toEqual([]);
    expect(listSourceStatus(t.db).find((s) => s.source === 'sec-feed')).toMatchObject({ state: 'blocked' });
  });

  test('a reader gets the EX-99.1 url without blocking the tick', async () => {
    const reader = vi.fn(() => new Promise<void>(() => {}));
    const t = setup({ reader });
    const ids = await t.watch.tick();
    expect(reader).toHaveBeenCalledWith(expect.stringContaining('udr-ex99d1.htm'), ids[0]);
  });

  test('a transient secTickers failure does not lose the batch: it flips on the next tick', async () => {
    const t = setup();
    const real = t.ctx.sources.secTickers;
    let calls = 0;
    t.ctx.sources.secTickers = async () => { if (calls++ === 0) throw new Error('boom'); return real(); };
    await expect(t.watch.tick()).rejects.toThrow('boom');
    expect(t.row().releasedAt).toBeNull();
    expect(await t.watch.tick()).toEqual([t.row().id]);
    expect(t.row().releasedAt).toBe('2026-10-21T12:05:10.000Z');
  });

  test('a later calendar refresh does not undo the flip', async () => {
    const t = setup({ row: { reportDate: '2026-10-20' } });
    await t.watch.tick();
    upsertCalendarRow(t.db, udr({ reportDate: '2026-10-20', timing: 'AMC' }), NOW, '2026-10-21');
    expect(t.row()).toMatchObject({ reportDate: '2026-10-21', rescheduledFrom: '2026-10-20', timing: 'BMO', timingSource: 'sec' });
    mergeFinnhubRow(t.db, { symbol: 'UDR', reportDate: '2026-10-21', timing: 'AMC', revenueEstimate: 1, revenueActual: null, epsActual: null }, NOW);
    expect(t.row()).toMatchObject({ reportDate: '2026-10-21', timing: 'BMO', timingSource: 'sec' });
  });
});
