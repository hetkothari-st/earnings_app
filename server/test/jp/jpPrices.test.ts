import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { syncJpUniverse, upsertJpCalendarRow } from '../../src/jp/db/jpRepo.js';
import { jpPeriodFor, jpPeriodLabel } from '../../src/jp/domain/period.js';
import { JpPrices, toDelayedQuotes } from '../../src/jp/live/jpPrices.js';
import type { YahooQuote } from '../../src/jp/sources/yahooJp.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';
import type { IndexQuote } from '../../src/sources/yahoo.js';
import { addWatch } from '../../src/watchlist/store.js';

// Tue 2026-10-27: a TSE trading day.
const IN_SESSION = Date.parse('2026-10-27T01:00:00Z');  // 10:00 JST
const AFTER_CLOSE = Date.parse('2026-10-27T09:00:00Z'); // 18:00 JST
// Thu 2026-12-31: a weekday, but the TSE year-end closure.
const YEAR_END = Date.parse('2026-12-31T01:00:00Z');    // 10:00 JST

const entry = (code: string, name: string, fyEndMonth: number): JpUniverseEntry => ({
  code, edinetCode: `E${code}`, name, nameJa: name, fyEndMonth, industryJa: null, adr: null, adrRatio: null, cik: null,
});
const ENTRIES = [entry('3382', 'Seven & i', 2), entry('6501', 'Hitachi', 3), entry('7203', 'Toyota', 3), entry('9983', 'Fast Retailing', 8)];

function setup(start: number) {
  const db = openDb(':memory:');
  syncJpUniverse(db, ENTRIES, new Date(start).toISOString());
  let t = start;
  const prices: Record<string, number> = { '3382.T': 2_000, '6501.T': 4_000, '7203.T': 3_000, '9983.T': 50_000 };
  const asked: string[][] = [];
  const quotes = vi.fn(async (symbols: string[]) => {
    asked.push(symbols);
    return new Map(symbols.filter((s) => prices[s] != null).map((s) => [s, { price: prices[s]!, prevClose: 1_000, time: t }]));
  });
  const quote = vi.fn(async (): Promise<{ price: number; prevClose: number; time: number }> => { throw new Error('unused'); });
  const index = vi.fn(async (s: string): Promise<IndexQuote> =>
    ({ symbol: s, price: 40_000, previousClose: 39_000, changePct: 2.56, asOf: new Date(t).toISOString(), currency: 'JPY' }));
  const published: Record<string, unknown>[] = [];
  const publishedIdx: unknown[] = [];
  const jp = new JpPrices(db, { quote, quotes, index }, (p) => published.push(p), (m) => publishedIdx.push(m), () => t);
  return { db, jp, prices, asked, quotes, quote, index, published, publishedIdx, advance: (ms: number) => { t += ms; } };
}

const row = (db: ReturnType<typeof openDb>, code: string, fyEndMonth: number, reportDate: string) => {
  const period = jpPeriodFor(reportDate, fyEndMonth);
  return upsertJpCalendarRow(db, { code, name: code, period, periodLabel: jpPeriodLabel(period), reportDate, dateStatus: 'estimated' }, '2026-10-27T00:00:00Z');
};

describe('JpPrices', () => {
  it('polls visible ∪ watched ∪ reporting codes, publishes only changes', async () => {
    const s = setup(IN_SESSION);
    addWatch(s.db, 'u2', 'JP', '6501', IN_SESSION);
    row(s.db, '3382', 2, '2026-10-28');  // tomorrow (JST)
    row(s.db, '9983', 8, '2026-11-20');  // in 3 weeks: not polled
    s.jp.setVisible('u1', ['7203']);

    await s.jp.tick();
    expect(s.asked).toEqual([['3382.T', '6501.T', '7203.T']]); // one batch request
    expect(s.quote).not.toHaveBeenCalled();
    expect(s.published).toHaveLength(1);
    expect(Object.keys(s.published[0]!).sort()).toEqual(['3382', '6501', '7203']);
    expect(s.jp.snapshot()['7203']).toMatchObject({ price: 3_000, prevClose: 1_000, changePct: 200 });
    expect(s.jp.indices().map((i) => i.index)).toEqual(['Nikkei 225', 'TOPIX (ETF 1306)']);
    expect(s.index.mock.calls.map((c) => c[0])).toEqual(['^N225', '1306.T']);

    // 15 s later: indices only (stocks once per 60 s in session).
    s.asked.length = 0;
    s.advance(15_000);
    await s.jp.tick();
    expect(s.asked).toEqual([]);

    // A minute after the first round: one price changed, only it is published.
    s.prices['3382.T'] = 2_100;
    s.advance(45_000);
    await s.jp.tick();
    expect(s.asked).toHaveLength(1);
    expect(s.published).toHaveLength(2);
    expect(Object.keys(s.published[1]!)).toEqual(['3382']);

    // Unchanged round: nothing published.
    s.advance(60_000);
    await s.jp.tick();
    expect(s.published).toHaveLength(2);
  });

  it('outside 08:45–15:45 JST stocks poll every 15 min', async () => {
    const s = setup(AFTER_CLOSE);
    addWatch(s.db, 'u1', 'JP', '7203', AFTER_CLOSE);
    await s.jp.tick();
    expect(s.quotes).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    await s.jp.tick();
    s.advance(13 * 60_000);
    await s.jp.tick();
    expect(s.quotes).toHaveBeenCalledTimes(1);
    expect(s.index).toHaveBeenCalledTimes(2); // indices only with the round, outside the session
    s.advance(60_000); // 15 min after the first round
    await s.jp.tick();
    expect(s.quotes).toHaveBeenCalledTimes(2);

    // 08:45 JST the next day is in session: every minute.
    const s2 = setup(Date.parse('2026-10-27T23:45:00Z'));
    addWatch(s2.db, 'u1', 'JP', '7203', 0);
    await s2.jp.tick();
    s2.advance(60_000);
    await s2.jp.tick();
    expect(s2.quotes).toHaveBeenCalledTimes(2);
  });

  it('year-end closure is off-session', async () => {
    const s = setup(YEAR_END);
    addWatch(s.db, 'u1', 'JP', '7203', YEAR_END);
    await s.jp.tick();
    expect(s.quotes).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    await s.jp.tick();
    s.advance(60_000);
    await s.jp.tick();
    expect(s.quotes).toHaveBeenCalledTimes(1);
    expect(s.index).toHaveBeenCalledTimes(2);
  });

  it('toDelayedQuotes keeps only quotes with a price, previous close and time', () => {
    const q = (symbol: string, o: Partial<YahooQuote>): YahooQuote =>
      ({ symbol, price: 100, prevClose: 90, time: 1_000, currency: 'JPY', marketCap: null, name: null, ...o });
    const m = toDelayedQuotes(new Map([['A.T', q('A.T', {})], ['B.T', q('B.T', { price: null })], ['C.T', q('C.T', { prevClose: null })], ['D.T', q('D.T', { time: null })]]));
    expect([...m]).toEqual([['A.T', { price: 100, prevClose: 90, time: 1_000 }]]);
  });
});
