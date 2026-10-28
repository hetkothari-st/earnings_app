import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradegatePoller, tradegateInHours, tradegatePriceTime } from '../../src/europe/live/tradegatePoller.js';
import type { TradegateQuote, TradegateState } from '../../src/europe/sources/tradegate.js';

afterEach(() => { vi.restoreAllMocks(); });

// Wednesday 2026-10-28, CET (UTC+1): 21:59 Berlin = 20:59Z, 22:01 Berlin = 21:01Z.
const IN_HOURS = Date.parse('2026-10-28T20:59:00.000Z');
const OFF_HOURS = Date.parse('2026-10-28T21:01:00.000Z');

const WANTED = [
  { isin: 'GB0009895292', symbol: 'AZN.L' },
  { isin: 'DE0007164600', symbol: 'SAP.DE' },
  { isin: 'FR0000120271', symbol: 'TTE.PA' },
];

function setup(start: number, initial: TradegateState = 'on') {
  let t = start;
  const fetched: string[] = [];
  const st: { state: TradegateState; wanted: { isin: string; symbol: string; visible?: boolean }[] } = { state: initial, wanted: [...WANTED] };
  const client = {
    state: vi.fn(() => st.state),
    checkRobots: vi.fn(async () => {}),
    quote: vi.fn(async (isin: string): Promise<TradegateQuote | null> => {
      fetched.push(isin);
      return { isin, last: 100 + fetched.length, close: 100, bid: null, ask: null, changePct: fetched.length, at: new Date(t).toISOString() };
    }),
  };
  const published: Record<string, TradegateQuote>[] = [];
  const states: TradegateState[] = [];
  const poller = new TradegatePoller(client, () => st.wanted, (c) => published.push(c), () => t, (s) => states.push(s));
  const advance = async (ms: number) => { t += ms; await poller.tick(); };
  return { poller, client, fetched, published, advance, st, states };
}

describe('TradegatePoller', () => {
  it('1 req/s round-robin, oldest first; ≤ every 30 s in hours, 15 min outside', async () => {
    expect(tradegateInHours(IN_HOURS)).toBe(true);
    expect(tradegateInHours(OFF_HOURS)).toBe(false);

    // In hours (21:59 Berlin).
    const a = setup(IN_HOURS);
    await a.advance(0);
    expect(a.client.checkRobots).toHaveBeenCalledTimes(1); // robots first; no quote in that second
    expect(a.fetched).toEqual([]);
    for (let i = 0; i < 3; i++) await a.advance(1000);
    expect(a.fetched).toEqual(['GB0009895292', 'DE0007164600', 'FR0000120271']); // one per tick, list order
    for (let i = 0; i < 26; i++) await a.advance(1000); // t = +29 s: AZN fetched at +1 s, not due before +31 s
    expect(a.fetched).toHaveLength(3);
    await a.advance(2000); // +31 s
    expect(a.fetched.at(-1)).toBe('GB0009895292'); // oldest first
    await a.advance(1000);
    expect(a.fetched.at(-1)).toBe('DE0007164600');
    expect(a.client.quote).toHaveBeenCalledTimes(5);
    expect(Object.keys(a.poller.snapshot()).sort()).toEqual(['AZN.L', 'SAP.DE', 'TTE.PA']);
    expect(a.published[0]).toHaveProperty('AZN.L');

    // Outside hours (22:01 Berlin): each ISIN every 15 min.
    const b = setup(OFF_HOURS);
    await b.advance(0);
    for (let i = 0; i < 3; i++) await b.advance(1000);
    expect(b.fetched).toHaveLength(3);
    await b.advance(60_000);
    await b.advance(10 * 60_000);
    expect(b.fetched).toHaveLength(3);
    await b.advance(4 * 60_000);
    expect(b.fetched).toEqual(['GB0009895292', 'DE0007164600', 'FR0000120271', 'GB0009895292']);
  });

  it("users' visible codes are polled first; the rest take the seconds left", async () => {
    const s = setup(IN_HOURS);
    s.st.wanted = [...WANTED.slice(0, 2), { ...WANTED[2]!, visible: true }];
    await s.advance(0); // robots
    await s.advance(1000);
    expect(s.fetched).toEqual(['FR0000120271']); // visible, though last in the list
    await s.advance(1000);
    await s.advance(1000);
    expect(s.fetched).toEqual(['FR0000120271', 'GB0009895292', 'DE0007164600']);
    // Due again at +31 s: the visible one goes first.
    for (let i = 0; i < 28; i++) await s.advance(1000);
    expect(s.fetched.at(-1)).toBe('FR0000120271');
  });

  it('an unchanged quote is published again once its last push is 45 s old (its time stays current)', async () => {
    let t = IN_HOURS - 3_600_000; // 20:59 Berlin
    const client = {
      state: () => 'on' as const,
      checkRobots: async () => {},
      quote: async (isin: string): Promise<TradegateQuote> => ({ isin, last: 100, close: 99, bid: null, ask: null, changePct: 1, at: new Date(t).toISOString() }),
    };
    const published: Record<string, TradegateQuote>[] = [];
    const poller = new TradegatePoller(client, () => [WANTED[0]!], (c) => published.push(c), () => t);
    await poller.tick(); // robots
    t += 1000; await poller.tick();
    expect(published).toHaveLength(1);
    t += 30_000; await poller.tick(); // unchanged, pushed 30 s ago: not pushed
    expect(published).toHaveLength(1);
    t += 30_000; await poller.tick(); // unchanged, pushed 60 s ago: pushed with the new time
    expect(published).toHaveLength(2);
    expect(published[1]!['AZN.L']!.at).toBe(new Date(t).toISOString());
  });

  it('backoff state → no fetch', async () => {
    for (const state of ['backoff', 'off-env', 'off-robots'] as const) {
      const s = setup(IN_HOURS, state);
      for (let i = 0; i < 5; i++) await s.advance(1000);
      expect(s.client.quote).not.toHaveBeenCalled();
      expect(s.poller.snapshot()).toEqual({});
    }
  });

  it('a symbol no longer wanted is pruned: its quote is no longer served', async () => {
    const s = setup(IN_HOURS);
    for (let i = 0; i < 4; i++) await s.advance(1000);
    expect(Object.keys(s.poller.snapshot()).sort()).toEqual(['AZN.L', 'SAP.DE', 'TTE.PA']);
    s.st.wanted = WANTED.filter((w) => w.symbol !== 'SAP.DE');
    await s.advance(1000);
    expect(Object.keys(s.poller.snapshot()).sort()).toEqual(['AZN.L', 'TTE.PA']);
    // Also while the client is not on (the wanted list is still read).
    s.st.state = 'backoff';
    s.st.wanted = [];
    await s.advance(1000);
    expect(s.poller.snapshot()).toEqual({});
  });

  it('reports each change of the client state', async () => {
    const s = setup(IN_HOURS);
    await s.advance(0);
    await s.advance(1000);
    s.st.state = 'backoff';
    await s.advance(1000);
    await s.advance(1000);
    s.st.state = 'on';
    await s.advance(1000);
    expect(s.states).toEqual(['on', 'backoff', 'on']);
  });

  it('robots.txt at start and weekly; hourly while it has not passed', async () => {
    const on = setup(IN_HOURS);
    await on.advance(0);
    await on.advance(6 * 86_400_000);
    expect(on.client.checkRobots).toHaveBeenCalledTimes(1);
    await on.advance(86_400_000);
    expect(on.client.checkRobots).toHaveBeenCalledTimes(2);

    const off = setup(IN_HOURS, 'off-robots');
    await off.advance(0);
    await off.advance(30 * 60_000);
    expect(off.client.checkRobots).toHaveBeenCalledTimes(1);
    await off.advance(30 * 60_000);
    expect(off.client.checkRobots).toHaveBeenCalledTimes(2);
  });

  it('price time: the fetch time in hours, else the last 22:00 Berlin close', () => {
    expect(tradegatePriceTime('2026-10-28T20:59:00.000Z')).toBe('2026-10-28T20:59:00.000Z');
    expect(tradegatePriceTime('2026-10-28T21:30:00.000Z')).toBe('2026-10-28T21:00:00.000Z');
    // Saturday morning: Friday's close.
    expect(tradegatePriceTime('2026-10-31T09:00:00.000Z')).toBe('2026-10-30T21:00:00.000Z');
    // Thursday 06:00 Berlin, before the open: Wednesday's close.
    expect(tradegatePriceTime('2026-10-29T05:00:00.000Z')).toBe('2026-10-28T21:00:00.000Z');
  });
});
