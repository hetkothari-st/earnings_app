import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { openDb } from '../../src/db/repo.js';
import type { IndexQuote } from '../../src/sources/yahoo.js';
import { mergeJpActuals, setJpEstimates, syncJpUniverse, upsertJpCalendarRow } from '../../src/jp/db/jpRepo.js';
import type { JpEarningsResponse, JpReportDto } from '../../src/jp/api/types.js';
import { JP_FULL, JP_INDICES, type JpUniverseEntry } from '../../src/jp/universe.js';

const NOW = '2026-10-27T00:00:00.000Z';
const entry = (code: string, name: string, extra: Partial<JpUniverseEntry> = {}): JpUniverseEntry => ({
  code, edinetCode: `E${code}`, name, nameJa: `${name}株式会社`, fyEndMonth: 3, industryJa: '電気機器', adr: null, adrRatio: null, cik: null, ...extra,
});

function setup() {
  const db = openDb(':memory:');
  syncJpUniverse(db, [
    entry('6501', 'HITACHI'),
    entry('6752', 'PANASONIC'),
    entry('6954', 'FANUC', { fyEndMonth: 9 }),
    entry('7203', 'TOYOTA', { adr: 'TM', adrRatio: 10, cik: 1094517 }),
  ], NOW);
  const mk = (code: string, name: string, q: 2 | 4 = 2) => upsertJpCalendarRow(db, {
    code, name,
    period: q === 2 ? { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' } : { periodEnd: '2026-09-30', fiscalQuarter: 4, fyEnd: '2026-09-30' },
    periodLabel: q === 2 ? '2Q FY27' : 'FY26', reportDate: '2026-11-05', dateStatus: 'confirmed',
  }, NOW);
  return { db, a: mk('6501', 'HITACHI'), b: mk('6752', 'PANASONIC'), c: mk('6954', 'FANUC', 4), d: mk('7203', 'TOYOTA') };
}

const rowsOf = async (app: ReturnType<typeof buildServer>) =>
  ((await app.inject({ url: '/api/jp/earnings?from=2026-11-05&to=2026-11-05' })).json() as JpEarningsResponse).rows;

describe('GET /api/jp/earnings', () => {
  it('colour only for same currency and same span', async () => {
    const { db, a, b, c, d } = setup();
    const quarterEst = { eps: 50, epsAnalysts: 8, revenue: 1000, revenueAnalysts: 7, currency: 'JPY', span: 'quarter' as const };
    // Quarter actual vs quarter estimate: coloured.
    setJpEstimates(db, a, quarterEst, NOW);
    mergeJpActuals(db, a, { revenue: { value: 1100, currency: 'JPY', span: 'quarter', ytdMonths: null },
      eps: { basic: 55, diluted: null, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'yahoo' }, NOW);
    // Six-month YTD actual vs quarter estimate: no colour, both numbers shown.
    setJpEstimates(db, b, quarterEst, NOW);
    mergeJpActuals(db, b, { revenue: { value: 2100, currency: 'JPY', span: 'ytd', ytdMonths: 6 },
      eps: { basic: 105, diluted: 104, currency: 'JPY', span: 'ytd', ytdMonths: 6 }, source: 'edinet', edinetDocId: 'S100AAAA' }, NOW);
    // Twelve-month YTD actual vs year estimate: coloured.
    setJpEstimates(db, c, { eps: 200, epsAnalysts: 12, revenue: 4000, revenueAnalysts: 11, currency: 'JPY', span: 'year' }, NOW);
    mergeJpActuals(db, c, { revenue: { value: 3800, currency: 'JPY', span: 'ytd', ytdMonths: 12 },
      eps: { basic: 210, diluted: 209, currency: 'JPY', span: 'ytd', ytdMonths: 12 }, source: 'edinet', edinetDocId: 'S100CCCC' }, NOW);
    // SEC EPS: no EPS colour; revenue keeps it.
    setJpEstimates(db, d, quarterEst, NOW);
    mergeJpActuals(db, d, { revenue: { value: 1100, currency: 'JPY', span: 'quarter', ytdMonths: null },
      eps: { basic: 55, diluted: 54, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'sec', docUrl: 'https://www.sec.gov/x' }, NOW);

    const rows = await rowsOf(buildServer(db));
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect(by(a).eps).toMatchObject({ result: 'beat', surprisePct: 10, estimateSpan: 'quarter', actualSpan: 'quarter' });
    expect(by(a).revenue).toMatchObject({ result: 'beat', surprisePct: 10 });
    expect(by(b).eps).toMatchObject({ result: null, surprisePct: null, estimate: 50, actual: 105, actualSpan: 'ytd', ytdMonths: 6 });
    expect(by(b).revenue).toMatchObject({ result: null, surprisePct: null, estimate: 1000, actual: 2100 });
    expect(by(c).eps).toMatchObject({ result: 'beat', estimateSpan: 'year', actualSpan: 'ytd', ytdMonths: 12 });
    expect(by(c).revenue).toMatchObject({ result: 'miss', surprisePct: -5 });
    expect(by(d).eps).toMatchObject({ result: null, surprisePct: null, estimate: 50, actual: 55, actualSource: 'sec' });
    expect(by(d).revenue).toMatchObject({ result: 'beat', surprisePct: 10, actualSource: 'sec' });
  });

  it('no colour when the currencies differ or are unknown', async () => {
    const { db, a } = setup();
    setJpEstimates(db, a, { eps: 50, epsAnalysts: 8, revenue: 1000, revenueAnalysts: 7, currency: 'USD', span: 'quarter' }, NOW);
    mergeJpActuals(db, a, { revenue: { value: 1100, currency: 'JPY', span: 'quarter', ytdMonths: null },
      eps: { basic: 55, diluted: null, currency: 'JPY', span: 'quarter', ytdMonths: null }, source: 'yahoo' }, NOW);
    const row = (await rowsOf(buildServer(db))).find((r) => r.id === a)!;
    expect(row.eps).toMatchObject({ result: null, surprisePct: null, estimateCurrency: 'USD', actualCurrency: 'JPY' });
    expect(row.revenue.result).toBeNull();
  });

  it('actualSource edinet, span and ytdMonths in the row', async () => {
    const { db, b, d } = setup();
    mergeJpActuals(db, b, { revenue: { value: 2100, currency: 'JPY', span: 'ytd', ytdMonths: 6 },
      eps: { basic: 105, diluted: 104, currency: 'JPY', span: 'ytd', ytdMonths: 6 }, source: 'edinet', edinetDocId: 'S100AAAA' }, NOW);
    const rows = await rowsOf(buildServer(db));
    const row = rows.find((r) => r.id === b) as JpReportDto;
    expect(row).toMatchObject({
      market: 'JP', symbol: '6752', name: 'PANASONIC', nameJa: 'PANASONIC株式会社', level: 'basic', adrTicker: null, adrRatio: null,
      period: '2Q FY27', periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31', dateStatus: 'confirmed', timing: 'UNKNOWN',
      industryJa: '電気機器', edinetDocId: 'S100AAAA', secDocUrl: null, epsDiluted: 104,
      eps: { actual: 105, actualCurrency: 'JPY', actualSource: 'edinet', actualSpan: 'ytd', ytdMonths: 6, estimate: null, estimateSpan: null },
      revenue: { actual: 2100, actualSource: 'edinet', actualSpan: 'ytd', ytdMonths: 6 },
      expectedMove: null, liveMove: null, previousMove: null,
    });
    expect(row.id).toBeGreaterThan(3_000_000_000);
    // The ratio is display-only and served only when the verify CLI recorded it as verified (20-F vs price-implied).
    const tmVerified = JP_FULL.find((e) => e.code === '7203')!.adrRatioVerified;
    expect(rows.find((r) => r.id === d)).toMatchObject({ level: 'full', adrTicker: 'TM', adrRatio: tmVerified ? 10 : null, eps: { actual: null, actualSource: null, actualSpan: null } });
  });

  it('rejects bad ranges', async () => {
    const app = buildServer(setup().db);
    expect((await app.inject({ url: '/api/jp/earnings?from=2026-11-16&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/jp/earnings?from=nope&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/jp/earnings?from=2025-01-01&to=2026-11-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/jp/earnings' })).statusCode).toBe(400);
  });

  it('search by Japanese name', async () => {
    const { db, a } = setup();
    const res = await buildServer(db).inject({ url: `/api/jp/earnings?from=2026-11-01&to=2026-11-30&q=${encodeURIComponent('HITACHI株式')}` });
    expect((res.json() as JpEarningsResponse).rows.map((r) => r.id)).toEqual([a]);
  });
});

describe('GET /api/jp/earnings/:id', () => {
  it('GET /api/jp/earnings/:id 404', async () => {
    const { db, a } = setup();
    const app = buildServer(db);
    expect((await app.inject({ url: `/api/jp/earnings/${a}` })).json()).toMatchObject({ id: a, symbol: '6501', market: 'JP' });
    expect((await app.inject({ url: '/api/jp/earnings/3000999999' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/jp/earnings/abc' })).statusCode).toBe(404);
  });
});

describe('GET /api/jp/markets', () => {
  it('markets falls back to index quotes for Nikkei 225 and TOPIX (ETF 1306)', async () => {
    let calls = 0;
    let now = 1_000_000;
    const asked: string[] = [];
    const indexQuote = async (symbol: string): Promise<IndexQuote> => {
      calls++;
      asked.push(symbol);
      if (symbol === '1306.T') throw new Error('no quote');
      return { symbol, price: 52000, previousClose: 51800, changePct: 0.39, asOf: '2026-10-27T06:30:00.000Z', currency: 'JPY' };
    };
    const app = buildServer(setup().db, { now: () => now, jp: { indexQuote } });
    const first = (await app.inject({ url: '/api/jp/markets' })).json() as { indices: { index: string; price: number | null }[] };
    expect(first.indices.map((i) => i.index)).toEqual(['Nikkei 225', 'TOPIX (ETF 1306)']);
    expect(first.indices.map((i) => i.price)).toEqual([52000, null]);
    expect(asked).toEqual(JP_INDICES.map((i) => i.yahoo));
    now += 14_000;
    await app.inject({ url: '/api/jp/markets' });
    expect(calls).toBe(2);
    now += 2_000;
    await app.inject({ url: '/api/jp/markets' });
    expect(calls).toBe(4);
  });

  it('prefers known indices and serves prices', async () => {
    const indices = [{ index: 'Nikkei 225', price: 1, changePct: 0, asOf: 'x' }];
    const app = buildServer(setup().db, { jp: { indices: () => indices, prices: () => ({ '7203': { price: 3000, prevClose: 2990, changePct: 0.33, at: 'x' } }) } });
    expect((await app.inject({ url: '/api/jp/markets' })).json()).toEqual({ indices });
    expect((await app.inject({ url: '/api/jp/prices' })).json()).toMatchObject({ prices: { '7203': { price: 3000 } } });
  });
});
