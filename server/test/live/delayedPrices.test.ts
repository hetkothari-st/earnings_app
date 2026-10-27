import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { DelayedPrices, type DelayedMarket } from '../../src/live/delayedPrices.js';
import type { IndexQuote } from '../../src/sources/yahoo.js';

// Tue 2026-10-27 20:00 in Tokyo: outside the session.
const OFF_SESSION = Date.parse('2026-10-27T11:00:00Z');

const MARKET: DelayedMarket = {
  market: 'JP',
  zone: 'Asia/Tokyo',
  isTradingDay: () => true,
  sessionFromMin: 9 * 60,
  sessionToMin: 15 * 60,
  symbolOf: (c) => `${c}.T`,
  indices: [{ name: 'Index', yahoo: '^IDX' }],
  failoverNames: { prices: 'test-prices', indices: 'test-indices' },
  reportingCodes: () => [],
};

function setup(start: number) {
  const db = openDb(':memory:');
  let t = start;
  const unquoted = new Set<string>();
  const batches: string[][] = [];
  const quote = vi.fn(async () => { throw new Error('single quotes are not used when batch quotes exist'); });
  const quotes = vi.fn(async (symbols: string[]) => {
    batches.push(symbols);
    return new Map(symbols.filter((s) => !unquoted.has(s)).map((s) => [s, { price: 100, prevClose: 90, time: t }]));
  });
  const index = vi.fn(async (s: string): Promise<IndexQuote> => ({ symbol: s, price: 1, previousClose: 1, changePct: 0, asOf: new Date(t).toISOString(), currency: 'JPY' }));
  const published: Record<string, unknown>[] = [];
  const dp = new DelayedPrices(MARKET, db, { quote, quotes, index }, (p) => published.push(p), () => {}, () => t);
  return { dp, quote, quotes, batches, unquoted, published, advance: (ms: number) => { t += ms; } };
}

describe('DelayedPrices', () => {
  it('batch quotes used in chunks of 50', async () => {
    const s = setup(OFF_SESSION);
    const codes = Array.from({ length: 120 }, (_, i) => String(1000 + i));
    s.dp.setVisible('u1', codes);
    await s.dp.tick();
    expect(s.batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(s.batches.flat()).toEqual(codes.map((c) => `${c}.T`));
    expect(s.quote).not.toHaveBeenCalled();
    expect(Object.keys(s.dp.snapshot())).toHaveLength(120);
    expect(s.published).toHaveLength(1);
    expect(s.dp.snapshot()['1000']).toMatchObject({ price: 100, prevClose: 90, changePct: 11.11 });
  });

  it('unpriced code fetched on the next tick', async () => {
    const s = setup(OFF_SESSION);
    await s.dp.tick(); // nothing to poll yet: the off-session round is spent
    expect(s.batches).toEqual([]);

    // Opened after the round: fetched at the next 15 s tick, not 15 minutes later.
    s.dp.setVisible('u1', ['7203', '285A']);
    s.unquoted.add('285A.T');
    s.advance(15_000);
    await s.dp.tick();
    expect(s.batches).toEqual([['285A.T', '7203.T']]);
    expect(s.dp.snapshot()['7203']).toMatchObject({ price: 100 });
    expect(s.dp.snapshot()['285A']).toBeUndefined();

    // The priced code is not asked again; the unquoted one is retried at most once a minute.
    s.batches.length = 0;
    s.advance(15_000);
    await s.dp.tick();
    expect(s.batches).toEqual([]);
    s.advance(45_000);
    await s.dp.tick();
    expect(s.batches).toEqual([['285A.T']]);
  });

  it('visibleCodes: what signed-in users saw in the last 2 minutes', () => {
    const s = setup(OFF_SESSION);
    s.dp.setVisible('u1', ['7203', '6758']);
    s.advance(60_000);
    s.dp.setVisible('u2', ['6758', '8306']);
    expect(s.dp.visibleCodes()).toEqual(['6758', '7203', '8306']);
    s.advance(60_000);
    expect(s.dp.visibleCodes()).toEqual(['6758', '8306']);
  });
});
