import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { getReport, openDb, upsertCalendarRow } from '../../src/db/repo.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { parseSharesOutstanding, refreshInShares, refreshUsShares } from '../../src/jobs/shares.js';
import { listInRange, saveFoList, syncWatched, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import type { InJobContext } from '../../src/india/jobs/context.js';
import { parseYahooInSummary } from '../../src/india/sources/yahooIn.js';
import { toDto } from '../../src/api/dto.js';
import type { Http } from '../../src/sources/http.js';
import type { CalendarRow } from '../../src/types.js';
import type { DatabaseSync } from 'node:sqlite';

const us = (f: string) => readFileSync(new URL(`../fixtures/us/${f}`, import.meta.url), 'utf8');
const india = (f: string) => readFileSync(new URL(`../fixtures/india/${f}`, import.meta.url), 'utf8');
const NOW = '2026-10-21T10:00:00.000Z';
const TODAY = '2026-10-21';

const cal = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  symbol: 'AAPL', name: 'Apple', reportDate: '2026-10-29', fiscalQuarter: 'Sep/2026', timing: 'AMC',
  marketCap: 3.5e12, epsEstimate: 1.6, noOfEsts: 30, epsActual: null, epsSurprisePct: null,
  lastYearEps: null, lastYearReportDate: null, ...over,
});

function usCtx(tickers: Record<string, number> = { AAPL: 320193, MSFT: 789019 }): JobContext {
  const sources = {
    secTickers: async () => new Map(Object.entries(tickers).map(([k, cik]) => [k, { cik, exchange: 'Nasdaq' }])),
  } as unknown as Sources;
  return { db: openDb(':memory:'), sources, now: () => NOW, today: () => TODAY };
}

describe('US share counts (SEC companyconcept)', () => {
  test('SEC companyconcept: latest end wins', () => {
    expect(parseSharesOutstanding(JSON.parse(us('sec_shares_aapl.json')))).toEqual({ shares: 14_594_180_000, asOf: '2026-07-17' });
    // Same end date: the later filing wins.
    expect(parseSharesOutstanding({ units: { shares: [
      { end: '2026-07-17', val: 1, filed: '2026-07-31' }, { end: '2026-07-17', val: 2, filed: '2026-08-05' }, { end: '2026-04-17', val: 3, filed: '2026-09-01' },
    ] } })).toEqual({ shares: 2, asOf: '2026-07-17' });
    expect(parseSharesOutstanding({ units: {} })).toBeNull();
    expect(parseSharesOutstanding({ units: { shares: [] } })).toBeNull();
  });

  test('stores the count on every row of the company; fetches only upcoming and watched symbols', async () => {
    const ctx = usCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    upsertCalendarRow(ctx.db, cal({ reportDate: '2026-07-30', fiscalQuarter: 'Jun/2026' }), NOW, '2026-07-01');
    upsertCalendarRow(ctx.db, cal({ symbol: 'MSFT', name: 'Microsoft', reportDate: '2027-03-30' }), NOW, TODAY); // too far out
    const urls: string[] = [];
    const http: Http = { text: async () => '', json: async (u) => { urls.push(u); return JSON.parse(us('sec_shares_aapl.json')); } };
    await refreshUsShares(ctx, http);
    expect(urls).toEqual(['https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/dei/EntityCommonStockSharesOutstanding.json']);
    const rows = ctx.db.prepare('SELECT shares_outstanding AS s, shares_as_of AS a FROM reports WHERE symbol_key = ?').all('AAPL');
    expect(rows).toEqual([{ s: 14_594_180_000, a: '2026-07-17' }, { s: 14_594_180_000, a: '2026-07-17' }]);
    expect(toDto(getReport(ctx.db, 1)!).sharesOutstanding).toBe(14_594_180_000);
  });

  test('missing shares keeps the stored cap', async () => {
    const ctx = usCtx();
    upsertCalendarRow(ctx.db, cal(), NOW, TODAY);
    await refreshUsShares(ctx, { text: async () => '', json: async () => JSON.parse(us('sec_shares_aapl.json')) });
    // Next day: SEC has nothing / fails. Stored share count and cap stay.
    await refreshUsShares(ctx, { text: async () => '', json: async () => ({ units: {} }) });
    const failing = vi.spyOn(console, 'error').mockImplementation(() => {});
    await refreshUsShares(ctx, { text: async () => '', json: async () => { throw new Error('boom'); } });
    failing.mockRestore();
    const r = ctx.db.prepare('SELECT shares_outstanding AS s, market_cap AS c FROM reports').get();
    expect(r).toEqual({ s: 14_594_180_000, c: 3.5e12 });
  });
});

describe('India share counts (Yahoo defaultKeyStatistics)', () => {
  test('parse: sharesOutstanding from the module; absent module is null', () => {
    expect(parseYahooInSummary(JSON.parse(india('yqs_RELIANCE_shares.NS.json'))).sharesOutstanding).toBe(13_532_472_634);
    expect(parseYahooInSummary(JSON.parse(india('yqs_RELIANCE.NS.json'))).sharesOutstanding).toBeNull();
  });

  function inCtx(shares: Record<string, number | null>): { ctx: InJobContext; db: DatabaseSync } {
    const db = openDb(':memory:') as unknown as DatabaseSync;
    saveFoList(db, [{ symbol: 'RELIANCE', name: 'Reliance', lotSize: 250 }, { symbol: 'GAIL', name: 'GAIL', lotSize: 3150 }], NOW);
    syncWatched(db, ['TCS'], new Map([['TCS', 'TCS Ltd']]), NOW);
    const ctx = {
      db, now: () => NOW, todayIST: () => TODAY,
      yahoo: async (s: string) => (s in shares ? { sharesOutstanding: shares[s]! } : null),
    } as unknown as InJobContext;
    return { ctx, db };
  }

  test('F&O and watched stocks are refreshed and reach the DTO; a null never blanks a stored count', async () => {
    const { ctx, db } = inCtx({ RELIANCE: 1.35e10, TCS: 3.6e9, GAIL: null });
    await refreshInShares(ctx);
    upsertInCalendarRow(db, { symbol: 'RELIANCE', name: 'Reliance', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-23', dateStatus: 'confirmed' }, NOW);
    expect(db.prepare('SELECT symbol, shares_outstanding AS s FROM in_stocks ORDER BY symbol').all())
      .toEqual([{ symbol: 'GAIL', s: null }, { symbol: 'RELIANCE', s: 1.35e10 }, { symbol: 'TCS', s: 3.6e9 }]);
    expect(listInRange(db, { from: '2026-10-01', to: '2026-11-30', q: null })[0]!.sharesOutstanding).toBe(1.35e10);
    const again = inCtx({});
    again.ctx.db = db;
    await refreshInShares(again.ctx); // Yahoo knows nothing now
    expect((db.prepare("SELECT shares_outstanding AS s FROM in_stocks WHERE symbol = 'RELIANCE'").get() as { s: number }).s).toBe(1.35e10);
  });
});
