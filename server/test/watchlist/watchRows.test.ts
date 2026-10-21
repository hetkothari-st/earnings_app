import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import type { WatchRowsResponse } from '../../src/api/types.js';
import { createSession, ensureAuthSchema } from '../../src/auth/store.js';
import { type Db, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import { listInForSymbols, listInRange, saveFoList, syncWatched, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { resetInResultsState } from '../../src/india/jobs/results.js';
import { getFoCache, loadFoCache } from '../../src/india/jobs/stocks.js';
import { NseWatch } from '../../src/india/live/nseWatch.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { createWatchBackfill } from '../../src/jobs/watchBackfill.js';
import { parseNasdaqEarningsSurprise } from '../../src/sources/nasdaq.js';
import { SymbolIndex } from '../../src/watchlist/search.js';
import { addWatch } from '../../src/watchlist/store.js';

const fixtureText = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), 'utf8');
const NOW = '2026-10-15T10:00:00.000Z';

describe('India: watched non-F&O stocks', () => {
  beforeEach(() => resetInResultsState());
  const ITEM = `<item><title>Relaxo Footwears Limited</title><link>https://nsearchives.nseindia.com/corporate/RELAXO_15102026.pdf</link><description>Relaxo Footwears Limited has informed the Exchange regarding Financial Results for the quarter ended September 30, 2026 |SUBJECT: Outcome of Board Meeting</description><pubDate>15-Oct-2026 15:10:00</pubDate></item>`;
  const feed = fixtureText('india/rss_Online_announcements.xml').replace('</channel>', `${ITEM}</channel>`);

  function setup() {
    const db = openDb(':memory:') as unknown as DatabaseSync;
    saveFoList(db, [{ symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }], NOW);
    const ctx: InJobContext = {
      db, http: { text: async () => feed, json: async () => { throw new Error('unused'); } },
      kite: { quotes: async () => new Map(), candles: async () => [] }, kiteSession: () => null,
      yahoo: async () => null, now: () => NOW, todayIST: () => '2026-10-15',
    };
    return { db, ctx };
  }

  test('a watched non-F&O NSE stock is matched by the results job but not listed in the calendar', async () => {
    const { db, ctx } = setup();
    syncWatched(db, ['RELAXO'], new Map([['RELAXO', 'RELAXO FOOTWEARS']]), NOW);
    expect(loadFoCache(db)!.symbols).toEqual(new Set(['TATACOMM', 'RELAXO']));
    const ids = await new NseWatch(ctx, () => {}).tick();
    expect(ids).toHaveLength(1);
    expect(listInRange(db, { from: '2026-10-01', to: '2026-10-31', q: null })).toEqual([]); // calendar stays F&O only
    expect(listInForSymbols(db, ['RELAXO'], '2026-10-01', '2026-10-31')).toMatchObject([
      { symbol: 'RELAXO', reportDate: '2026-10-15', quarterEnd: '2026-09-30' },
    ]);
  });

  test('an unwatched non-F&O stock is ignored; un-watching removes it from the cache', async () => {
    const { db, ctx } = setup();
    loadFoCache(db);
    expect(await new NseWatch(ctx, () => {}).tick()).toEqual([]);
    syncWatched(db, ['RELAXO'], new Map(), NOW);
    expect(getFoCache()!.symbols.has('RELAXO')).toBe(false); // cache only changes on loadFoCache
    loadFoCache(db);
    expect(getFoCache()!.symbols.has('RELAXO')).toBe(true);
    syncWatched(db, [], new Map(), NOW);
    loadFoCache(db);
    expect(getFoCache()!.symbols.has('RELAXO')).toBe(false);
  });

  test('watching an F&O stock keeps it active; the F&O list refresh keeps watched flags', () => {
    const { db } = setup();
    syncWatched(db, ['TATACOMM'], new Map(), NOW);
    saveFoList(db, [{ symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS', lotSize: 350 }], NOW);
    expect(db.prepare('SELECT active, watched FROM in_stocks WHERE symbol = ?').get('TATACOMM')).toEqual({ active: 1, watched: 1 });
  });
});

describe('GET /api/watchlist/rows', () => {
  let db: Db;
  let app: ReturnType<typeof buildServer>;
  const clock = Date.parse('2026-10-15T12:00:00Z');
  beforeEach(() => {
    db = openDb(':memory:');
    ensureAuthSchema(db);
    db.prepare('INSERT INTO users (id, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)').run('1A', 'x', '2026-10-01T00:00:00Z');
    const index = new SymbolIndex();
    index.set('US', [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq' }, { symbol: 'NEWCO', name: 'Newco Inc', exchange: 'NYSE' }]);
    index.set('IN', [{ symbol: 'RELAXO', name: 'RELAXO FOOTWEARS', exchange: 'NSE' }, { symbol: 'INFY', name: 'INFOSYS', exchange: 'NSE' }]);
    app = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index } });
  });
  const get = (market: string) => app.inject({ method: 'GET', url: `/api/watchlist/rows?market=${market}`, headers: { cookie: `session=${createSession(db, '1A', clock).token}` } });
  const us = (fiscalQuarter: string, reportDate: string, epsActual: number | null) => ({
    symbol: 'AAPL', name: 'Apple Inc.', reportDate, fiscalQuarter, timing: 'AMC' as const, marketCap: null, epsEstimate: 1.5, noOfEsts: 10,
    epsActual, epsSurprisePct: epsActual == null ? null : 6, lastYearEps: null, lastYearReportDate: null,
  });

  test('rows: next and latest reports per watched symbol; none -> nulls', async () => {
    addWatch(db, '1A', 'US', 'AAPL', clock);
    addWatch(db, '1A', 'US', 'NEWCO', clock + 1000);
    upsertCalendarRow(db, us('Jun/2026', '2026-07-30', 1.91), NOW, '2026-07-30');
    upsertCalendarRow(db, us('Mar/2026', '2026-04-30', 2.01), NOW, '2026-04-30');
    upsertCalendarRow(db, us('Sep/2026', '2026-10-29', null), NOW, '2026-10-15');
    const res = await get('US');
    expect(res.statusCode).toBe(200);
    const body = res.json() as WatchRowsResponse;
    expect(body.rows.map((r) => r.symbol)).toEqual(['AAPL', 'NEWCO']);
    expect(body.rows[0]).toMatchObject({ name: 'Apple Inc.', next: { fiscalQuarter: 'Sep/2026', reportDate: '2026-10-29' }, latest: { fiscalQuarter: 'Jun/2026' } });
    expect(body.rows[1]).toEqual({ symbol: 'NEWCO', name: 'Newco Inc', next: null, latest: null });
  });

  test('India rows include non-F&O stocks and the symbol name from the index', async () => {
    const dbn = db as unknown as DatabaseSync;
    addWatch(db, '1A', 'IN', 'RELAXO', clock);
    addWatch(db, '1A', 'IN', 'INFY', clock + 1000);
    syncWatched(dbn, ['RELAXO', 'INFY'], new Map([['RELAXO', 'RELAXO FOOTWEARS']]), NOW);
    upsertInCalendarRow(dbn, { symbol: 'RELAXO', name: 'RELAXO FOOTWEARS', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-28' }, NOW);
    upsertInCalendarRow(dbn, { symbol: 'RELAXO', name: 'RELAXO FOOTWEARS', quarterEnd: '2026-06-30', quarterLabel: 'Jun/2026', reportDate: '2026-08-05' }, NOW);
    const body = (await get('IN')).json() as WatchRowsResponse;
    expect(body.rows[0]).toMatchObject({ symbol: 'RELAXO', next: { fiscalQuarter: 'Sep/2026' }, latest: { fiscalQuarter: 'Jun/2026' } });
    expect(body.rows[1]).toEqual({ symbol: 'INFY', name: 'INFOSYS', next: null, latest: null });
  });

  test('rows needs sign-in and a market', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/watchlist/rows?market=US' })).statusCode).toBe(401);
    expect((await get('XX')).statusCode).toBe(400);
  });

  test('a new symbol triggers onWatchAdded once; a re-add does not; a hook failure does not fail the add', async () => {
    const calls: string[] = [];
    const index = new SymbolIndex();
    index.set('US', [{ symbol: 'AAPL', name: 'Apple', exchange: 'Nasdaq' }]);
    const app2 = buildServer(db, { requireAuth: true, now: () => clock, watchlist: { index, onWatchAdded: (m, s) => { calls.push(`${m}:${s}`); throw new Error('boom'); } } });
    const headers = { cookie: `session=${createSession(db, '1A', clock).token}` };
    expect((await app2.inject({ method: 'PUT', url: '/api/watchlist/US/AAPL', headers })).statusCode).toBe(204);
    expect((await app2.inject({ method: 'PUT', url: '/api/watchlist/US/AAPL', headers })).statusCode).toBe(204);
    expect(calls).toEqual(['US:AAPL']);
  });
});

describe('US watch backfill', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  const mk = (sources: Partial<Sources>): JobContext => ({ db, sources: sources as Sources, now: () => NOW, today: () => '2026-10-15' });
  const rows = () => db.prepare('SELECT symbol_key, fiscal_quarter, report_date, eps_actual, eps_estimate, eps_actual_source FROM reports ORDER BY report_date').all();

  test('the real Nasdaq earnings-surprise response parses to past quarters', () => {
    const parsed = parseNasdaqEarningsSurprise(JSON.parse(fixtureText('us/nasdaq_earnings_surprise_aapl.json')));
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ fiscalQuarter: 'Jun/2026', reportDate: '2026-07-30', epsActual: 1.91, epsEstimate: 1.88 });
  });

  test('US add triggers one backfill; failure falls back to Yahoo', async () => {
    let nasdaqCalls = 0;
    let yahooCalls = 0;
    const ctx = mk({
      earningsSurprise: async () => { nasdaqCalls++; throw new Error('nasdaq down'); },
      yahooSummary: async () => {
        yahooCalls++;
        return { priceCurrency: 'USD', financialCurrency: 'USD', revenueQuarters: [], revenueEstimates: [],
          epsHistory: [{ periodEnd: '2026-06-30', actual: 1.91, currency: 'USD' }, { periodEnd: '2026-03-31', actual: 2.01, currency: 'USD' }] };
      },
    });
    const backfill = createWatchBackfill(ctx);
    await backfill('AAPL');
    await backfill('AAPL'); // already done: no second fetch
    expect(yahooCalls).toBe(1);
    expect(nasdaqCalls).toBe(1);
    expect(rows()).toMatchObject([
      { symbol_key: 'AAPL', fiscal_quarter: 'Mar/2026', eps_actual: 2.01, eps_actual_source: 'yahoo' },
      { symbol_key: 'AAPL', fiscal_quarter: 'Jun/2026', eps_actual: 1.91, eps_actual_source: 'yahoo' },
    ]);
  });

  test('Nasdaq rows are stored with source nasdaq; existing calendar rows are filled, never overwritten or duplicated', async () => {
    upsertCalendarRow(db, { symbol: 'AAPL', name: 'Apple Inc.', reportDate: '2026-07-30', fiscalQuarter: 'Jun/2026', timing: 'AMC', marketCap: null,
      epsEstimate: 1.9, noOfEsts: 5, epsActual: 1.95, epsSurprisePct: 2.6, lastYearEps: null, lastYearReportDate: null }, NOW, '2026-07-30');
    const ctx = mk({ earningsSurprise: async () => parseNasdaqEarningsSurprise(JSON.parse(fixtureText('us/nasdaq_earnings_surprise_aapl.json'))) });
    await createWatchBackfill(ctx)('AAPL');
    expect(rows()).toHaveLength(4);
    expect(rows()).toMatchObject([
      { fiscal_quarter: 'Sep/2025', eps_actual: 1.85, eps_actual_source: 'nasdaq' },
      { fiscal_quarter: 'Dec/2025', eps_actual: 2.84 },
      { fiscal_quarter: 'Mar/2026', eps_actual: 2.01 },
      { fiscal_quarter: 'Jun/2026', eps_actual: 1.95, eps_estimate: 1.9, eps_actual_source: 'nasdaq' },
    ]);
  });

  test('both sources failing stores nothing and a later call retries', async () => {
    let n = 0;
    const ctx = mk({ earningsSurprise: async () => { n++; throw new Error('x'); }, yahooSummary: async () => null });
    const backfill = createWatchBackfill(ctx);
    await backfill('AAPL');
    await backfill('AAPL');
    expect(rows()).toEqual([]);
    expect(n).toBe(2);
  });
});
