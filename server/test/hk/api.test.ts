import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { openDb } from '../../src/db/repo.js';
import type { IndexQuote } from '../../src/sources/yahoo.js';
import { mergeHkActuals, setHkEstimates, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import type { HkEarningsResponse, HkReportDto } from '../../src/hk/api/types.js';
import { HK_INDICES } from '../../src/hk/universe.js';

const NOW = '2026-10-27T00:00:00.000Z';

function setup() {
  const db = openDb(':memory:');
  syncHkUniverse(db, [
    { code: '9988', name: 'Alibaba', cadence: 'Q', fyEndMonth: 3, adr: 'BABA', adrRatio: 8, cik: 1577552 },
    { code: '9618', name: 'JD.com', cadence: 'Q', fyEndMonth: 12, adr: 'JD', adrRatio: 2, cik: 1549802 },
    { code: '0285', name: 'BYD Electronic', cadence: 'H', fyEndMonth: 12, adr: null, adrRatio: null, cik: null },
  ], NOW);
  const mk = (code: string, name: string) => upsertHkCalendarRow(db, {
    code, name, periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-11-13', dateStatus: 'confirmed',
  }, NOW);
  return { db, a: mk('9988', 'Alibaba'), b: mk('9618', 'JD.com'), c: mk('0285', 'BYD Electronic') };
}

const rowsOf = async (app: ReturnType<typeof buildServer>) =>
  ((await app.inject({ url: '/api/hk/earnings?from=2026-11-13&to=2026-11-13' })).json() as HkEarningsResponse).rows;

describe('GET /api/hk/earnings', () => {
  it('beat/miss only with same currency and per-share basis', async () => {
    const { db, a, b, c } = setup();
    // Same currency, per share: beat.
    setHkEstimates(db, a, { eps: 2.1, epsAnalysts: 5, revenue: 100, revenueAnalysts: 4, currency: 'CNY' }, NOW);
    mergeHkActuals(db, a, { revenue: 110, revenueCurrency: 'CNY', eps: 2.3, epsCurrency: 'CNY', epsBasis: 'share', source: 'sec' }, NOW);
    // Estimate HKD vs actual CNY: no colour, both numbers shown.
    setHkEstimates(db, b, { eps: 2.1, epsAnalysts: 5, revenue: 100, revenueAnalysts: 4, currency: 'HKD' }, NOW);
    mergeHkActuals(db, b, { revenue: 110, revenueCurrency: 'CNY', eps: 2.3, epsCurrency: 'CNY', epsBasis: 'share', source: 'sec' }, NOW);
    // Per-ADS actual: no EPS colour (revenue currencies match).
    setHkEstimates(db, c, { eps: 2.1, epsAnalysts: 5, revenue: 100, revenueAnalysts: 4, currency: 'CNY' }, NOW);
    mergeHkActuals(db, c, { revenue: 110, revenueCurrency: 'CNY', eps: 2.3, epsCurrency: 'CNY', epsBasis: 'ads', source: 'sec' }, NOW);

    const rows = await rowsOf(buildServer(db));
    const by = (sym: string) => rows.find((r) => r.symbol === sym)!;
    // SEC EPS is GAAP diluted; the consensus is adjusted: no EPS colour (as US dto). Revenue keeps its colour.
    expect(by('9988').eps).toMatchObject({ result: null, surprisePct: null, estimate: 2.1, actual: 2.3 });
    expect(by('9988').revenue).toMatchObject({ result: 'beat', surprisePct: 10 });
    expect(by('9618').eps).toMatchObject({ result: null, surprisePct: null, estimate: 2.1, actual: 2.3, estimateCurrency: 'HKD', actualCurrency: 'CNY' });
    expect(by('9618').revenue).toMatchObject({ result: null, surprisePct: null, estimate: 100, actual: 110 });
    expect(by('0285').eps).toMatchObject({ result: null, surprisePct: null, estimate: 2.1, actual: 2.3 });
    expect(by('0285').revenue.result).toBe('beat');
  });

  it('a Yahoo per-share EPS in the estimate currency gets colour and surprise', async () => {
    const { db, c } = setup();
    setHkEstimates(db, c, { eps: 2.1, epsAnalysts: 5, revenue: 100, revenueAnalysts: 4, currency: 'CNY' }, NOW);
    mergeHkActuals(db, c, { revenue: 90, revenueCurrency: 'CNY', eps: 2.3, epsCurrency: 'CNY', epsBasis: 'share', source: 'yahoo' }, NOW);
    const row = (await rowsOf(buildServer(db))).find((r) => r.id === c)!;
    expect(row.eps).toMatchObject({ result: 'beat', surprisePct: 9.5 });
    expect(row.revenue).toMatchObject({ result: 'miss', surprisePct: -10 });
  });

  it('level, currency, epsBasis, actualSource and period are in the row', async () => {
    const { db, a, c } = setup();
    mergeHkActuals(db, a, { revenue: 110, revenueCurrency: 'CNY', eps: 2.3, epsCurrency: 'CNY', epsBasis: 'ads', source: 'sec', docUrl: 'https://www.sec.gov/x' }, NOW);
    const rows = await rowsOf(buildServer(db));
    const full = rows.find((r) => r.symbol === '9988') as HkReportDto;
    expect(full).toMatchObject({
      market: 'HK', level: 'full', adrTicker: 'BABA', adrRatio: 8, currency: 'CNY', epsBasis: 'ads', actualSource: 'sec',
      secDocUrl: 'https://www.sec.gov/x', period: 'Q3 26', periodEnd: '2026-09-30', periodKind: 'Q', dateStatus: 'confirmed', timing: 'UNKNOWN',
    });
    expect(full.id).toBeGreaterThan(2_000_000_000);
    expect(rows.find((r) => r.id === c)).toMatchObject({ level: 'basic', adrTicker: null, currency: null, actualSource: null });
  });

  it('rejects bad ranges', async () => {
    const app = buildServer(setup().db);
    expect((await app.inject({ url: '/api/hk/earnings?from=2026-11-16&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/hk/earnings?from=nope&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/hk/earnings?from=2025-01-01&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/hk/earnings' })).statusCode).toBe(400);
  });
});

describe('GET /api/hk/earnings/:id', () => {
  it('returns the row and 404s when missing', async () => {
    const { db, a } = setup();
    const app = buildServer(db);
    expect((await app.inject({ url: `/api/hk/earnings/${a}` })).json()).toMatchObject({ id: a, symbol: '9988' });
    expect((await app.inject({ url: '/api/hk/earnings/2000999999' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/hk/earnings/abc' })).statusCode).toBe(404);
  });
});

describe('GET /api/hk/markets', () => {
  it('falls back to index quotes and caches 15 s', async () => {
    let calls = 0;
    let now = 1_000_000;
    const indexQuote = async (symbol: string): Promise<IndexQuote> => {
      calls++;
      if (symbol === '^HSCE') throw new Error('no quote');
      return { symbol, price: 20000, previousClose: 19900, changePct: 0.5, asOf: '2026-10-27T08:00:00.000Z', currency: 'HKD' };
    };
    const app = buildServer(setup().db, { now: () => now, hk: { indexQuote } });
    const first = (await app.inject({ url: '/api/hk/markets' })).json() as { indices: { index: string; price: number | null }[] };
    expect(first.indices.map((i) => i.index)).toEqual(HK_INDICES.map((i) => i.name));
    expect(first.indices.map((i) => i.price)).toEqual([20000, null, 20000]);
    expect(calls).toBe(HK_INDICES.length);
    now += 14_000;
    await app.inject({ url: '/api/hk/markets' });
    expect(calls).toBe(HK_INDICES.length);
    now += 2_000;
    await app.inject({ url: '/api/hk/markets' });
    expect(calls).toBe(HK_INDICES.length * 2);
  });

  it('prefers known indices and serves prices', async () => {
    const indices = [{ index: 'Hang Seng', price: 1, changePct: 0, asOf: 'x' }];
    const app = buildServer(setup().db, { hk: { indices: () => indices, prices: () => ({ '9988': { price: 100, prevClose: 99, changePct: 1.01, at: 'x' } }) } });
    expect((await app.inject({ url: '/api/hk/markets' })).json()).toEqual({ indices });
    expect((await app.inject({ url: '/api/hk/prices' })).json()).toMatchObject({ prices: { '9988': { price: 100 } } });
  });
});
