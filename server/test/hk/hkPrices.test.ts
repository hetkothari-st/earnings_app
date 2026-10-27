import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import { HkPrices } from '../../src/hk/live/hkPrices.js';
import { HK_UNIVERSE } from '../../src/hk/universe.js';
import type { IndexQuote } from '../../src/sources/yahoo.js';
import { addWatch } from '../../src/watchlist/store.js';

// Tue 2026-10-27: an HK trading day.
const IN_SESSION = Date.parse('2026-10-27T02:00:00Z');  // 10:00 HKT
const AFTER_CLOSE = Date.parse('2026-10-27T10:00:00Z'); // 18:00 HKT

function setup(start: number) {
  const db = openDb(':memory:');
  syncHkUniverse(db, HK_UNIVERSE, new Date(start).toISOString());
  let t = start;
  const prices: Record<string, number> = { '0700.HK': 500, '9988.HK': 150, '0005.HK': 100, '1299.HK': 70 };
  const quoted: string[] = [];
  const indexFails = new Set<string>();
  const quote = vi.fn(async (s: string) => {
    quoted.push(s);
    const p = prices[s];
    if (p == null) throw new Error(`no quote for ${s}`);
    return { price: p, prevClose: 100, time: t };
  });
  const index = vi.fn(async (s: string): Promise<IndexQuote> => {
    if (indexFails.has(s)) throw new Error('index down');
    return { symbol: s, price: 25_000, previousClose: 24_500, changePct: 2.04, asOf: new Date(t).toISOString(), currency: 'HKD' };
  });
  const published: Record<string, unknown>[] = [];
  const publishedIdx: unknown[] = [];
  const hp = new HkPrices(db, { quote, index }, (p) => published.push(p), (m) => publishedIdx.push(m), () => t);
  return {
    db, hp, prices, quoted, quote, index, indexFails, published, publishedIdx,
    advance: (ms: number) => { t += ms; },
  };
}

describe('HkPrices', () => {
  it('a code with no price yet is fetched on the next tick, even outside the session', async () => {
    const s = setup(AFTER_CLOSE);
    await s.hp.tick(); // nothing to poll yet (no rows, nobody looking)
    expect(s.quoted).toEqual([]);

    s.hp.setVisible('u1', ['0700']);
    s.advance(15_000);
    await s.hp.tick();
    expect(s.quoted).toEqual(['0700.HK']);
    expect(s.hp.snapshot()['0700']).toMatchObject({ price: 500 });

    // Priced now: no refetch until the 15-minute off-session round.
    s.quoted.length = 0;
    s.advance(15_000);
    await s.hp.tick();
    expect(s.quoted).toEqual([]);
  });

  it('a code Yahoo cannot quote is retried at most once a minute', async () => {
    const s = setup(AFTER_CLOSE);
    s.hp.setVisible('u1', ['2382']); // no price in the stub: every quote fails
    await s.hp.tick();
    expect(s.quoted).toEqual(['2382.HK']);
    s.quoted.length = 0;
    s.advance(15_000);
    await s.hp.tick();
    expect(s.quoted).toEqual([]);
    s.advance(45_000);
    await s.hp.tick();
    expect(s.quoted).toEqual(['2382.HK']);
  });

  it('polls visible ∪ watched ∪ reporting codes and publishes only changes', async () => {
    const s = setup(IN_SESSION);
    addWatch(s.db, 'u2', 'HK', '0005', IN_SESSION);
    upsertHkCalendarRow(s.db, { code: '9988', name: 'Alibaba', periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-10-28', dateStatus: 'estimated' }, '2026-10-27T00:00:00Z');
    upsertHkCalendarRow(s.db, { code: '1299', name: 'AIA', periodEnd: '2026-06-30', periodKind: 'H', periodLabel: '1H26', reportDate: '2026-11-20', dateStatus: 'estimated' }, '2026-10-27T00:00:00Z');
    s.hp.setVisible('u1', ['0700']);

    await s.hp.tick();
    expect(new Set(s.quoted)).toEqual(new Set(['0700.HK', '9988.HK', '0005.HK'])); // 1299 reports in 3 weeks: not polled
    expect(s.published).toHaveLength(1);
    expect(Object.keys(s.published[0]!).sort()).toEqual(['0005', '0700', '9988']);
    expect(s.hp.snapshot()['0700']).toMatchObject({ price: 500, prevClose: 100, changePct: 400 });

    // 15 s later: indices only (stocks once per 60 s in session).
    s.quoted.length = 0;
    s.advance(15_000);
    await s.hp.tick();
    expect(s.quoted).toEqual([]);

    // A minute after the first round: one price changed, only it is published.
    s.prices['9988.HK'] = 151;
    s.advance(45_000);
    await s.hp.tick();
    expect(s.quoted.length).toBe(3);
    expect(s.published).toHaveLength(2);
    expect(Object.keys(s.published[1]!)).toEqual(['9988']);

    // Unchanged round: nothing published.
    s.advance(60_000);
    await s.hp.tick();
    expect(s.published).toHaveLength(2);
  });

  it('outside the HK session stocks poll every 15 min', async () => {
    const s = setup(AFTER_CLOSE);
    addWatch(s.db, 'u1', 'HK', '0700', AFTER_CLOSE);
    await s.hp.tick();
    expect(s.quote).toHaveBeenCalledTimes(1);
    s.advance(60_000);
    await s.hp.tick();
    s.advance(13 * 60_000);
    await s.hp.tick();
    expect(s.quote).toHaveBeenCalledTimes(1);
    s.advance(60_000); // 15 min after the first round
    await s.hp.tick();
    expect(s.quote).toHaveBeenCalledTimes(2);
    // refresh() re-picks and polls now, whatever the cadence.
    s.hp.setVisible('u3', ['0005']);
    s.hp.refresh();
    await vi.waitFor(() => expect(s.quote).toHaveBeenCalledTimes(4));
  });

  it('a visible set expires after 2 minutes', async () => {
    const s = setup(AFTER_CLOSE);
    s.hp.setVisible('u1', ['0700']);
    s.advance(2 * 60_000);
    await s.hp.tick();
    expect(s.quote).not.toHaveBeenCalled();
  });

  it('index failure keeps the last value', async () => {
    const s = setup(IN_SESSION);
    await s.hp.tick();
    expect(s.hp.indices()).toEqual([
      { index: 'Hang Seng', price: 25_000, changePct: 2.04, asOf: new Date(IN_SESSION).toISOString() },
      { index: 'HS China Enterprises', price: 25_000, changePct: 2.04, asOf: new Date(IN_SESSION).toISOString() },
      { index: 'HS Tech', price: 25_000, changePct: 2.04, asOf: new Date(IN_SESSION).toISOString() },
    ]);
    expect(s.publishedIdx).toHaveLength(1);
    s.indexFails.add('^HSI');
    s.advance(15_000);
    await s.hp.tick();
    expect(s.hp.indices()[0]).toEqual({ index: 'Hang Seng', price: 25_000, changePct: 2.04, asOf: new Date(IN_SESSION).toISOString() });
    expect(s.index).toHaveBeenCalledTimes(6);
  });
});
