import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import type { Trade } from '../../src/domain/priceBook.js';
import { LivePrices, pickSlots } from '../../src/live/livePrices.js';
import { toFinnhub } from '../../src/sources/finnhubStream.js';

const names = (n: number, p = 'S') => Array.from({ length: n }, (_, i) => `${p}${i}`);
const T0 = Date.parse('2026-10-21T15:00:00Z');

function setup(over: { watched?: string[]; reporters?: string[]; finnhub?: (s: string) => Promise<{ price: number; prevClose: number; time: number } | null>; yahoo?: (s: string) => Promise<{ price: number; prevClose: number; time: number } | null> } = {}) {
  const clock = { t: T0 };
  const streamed: string[][] = [];
  let onTrades: (t: Trade[]) => void = () => {};
  const finnhubCalls: string[] = [];
  const lp = new LivePrices(openDb(':memory:'), 'tok', {} as never, () => '2026-10-21', () => {}, {
    now: () => clock.t,
    watched: () => over.watched ?? [],
    reporters: () => over.reporters ?? [],
    makeStream: (cb) => { onTrades = cb; return { setSymbols: (s) => { streamed.push(s); }, stop: () => {} }; },
    finnhubQuote: async (s) => { finnhubCalls.push(s); return over.finnhub ? over.finnhub(s) : { price: 10, prevClose: 9, time: T0 }; },
    yahooQuote: over.yahoo,
  });
  return { lp, clock, streamed, finnhubCalls, trade: (t: Trade[]) => onTrades(t) };
}

describe('pickSlots', () => {
  test('pickSlots: watch first, then visible, then reporters; dedup; 50 cap; rest polled', () => {
    const watch = names(30, 'W');
    const visible = [...names(15, 'V'), 'W3'];
    const reporters = [...names(20, 'R'), 'V0'];
    const { stream, poll } = pickSlots(watch, visible, reporters, 50);
    expect(stream).toEqual([...watch, ...names(15, 'V'), ...names(5, 'R')]);
    expect(poll).toEqual(names(15, 'R').map((_, i) => `R${i + 5}`));
    expect(new Set([...stream, ...poll]).size).toBe(stream.length + poll.length);
  });
});

describe('LivePrices', () => {
  test('stream failure: polled and Yahoo backup fill, source backup', async () => {
    const { lp } = setup({
      watched: ['AAA'],
      finnhub: async () => { throw new Error('HTTP 500'); },
      yahoo: async () => ({ price: 12, prevClose: 10, time: T0 }),
    });
    await lp.repick();
    await lp.quoteOnce();
    expect(lp.snapshot().AAA).toMatchObject({ price: 12, changePct: 20, source: 'backup' });
  });

  test('stream trades are source stream; Finnhub quotes beyond 50 are poll', async () => {
    const { lp, trade, streamed } = setup({ watched: names(52, 'W') });
    await lp.repick();
    expect(streamed.at(-1)).toHaveLength(50);
    trade([{ s: 'W0', p: 11, t: T0 + 1000 }]);
    for (let i = 0; i < 60; i++) await lp.quoteOnce();
    expect(lp.snapshot().W0?.source).toBe('stream');
    expect(lp.snapshot().W51).toMatchObject({ source: 'poll' });
  });

  test('visible symbols expire after 2 min', async () => {
    const { lp, clock, streamed } = setup({ watched: ['W'] });
    lp.setVisible('u1', ['V1']);
    await lp.repick();
    expect(streamed.at(-1)).toEqual(['W', 'V1']);
    clock.t += 2 * 60_000 - 1;
    await lp.repick();
    expect(streamed.at(-1)).toEqual(['W', 'V1']);
    clock.t += 2;
    await lp.repick();
    expect(streamed.at(-1)).toEqual(['W']);
  });

  test('stream list is only set when it changes', async () => {
    const { lp, streamed } = setup({ watched: ['W'] });
    await lp.repick(); await lp.repick(); await lp.repick();
    expect(streamed).toHaveLength(1);
  });

  test('never more than 55 Finnhub price calls in a rolling minute (5 are left for the earnings jobs)', async () => {
    const { lp, clock, finnhubCalls } = setup({ watched: names(120, 'W') });
    await lp.repick();
    for (let i = 0; i < 200; i++) await lp.quoteOnce();
    expect(finnhubCalls.length).toBe(55);
    clock.t += 60_001;
    for (let i = 0; i < 200; i++) await lp.quoteOnce();
    expect(finnhubCalls.length).toBe(110);
  });

  test('a share-class ticker takes one slot under one key and is quoted as BRK.B', async () => {
    const urls: string[] = [];
    const lp = new LivePrices(openDb(':memory:'), 'tok', { json: async (u: string) => { urls.push(u); return { c: 10, pc: 9, t: T0 / 1000 }; } } as never, () => '2026-10-21', () => {}, {
      now: () => T0,
      watched: () => ['BRK-B'],
      reporters: () => ['BRK/B', 'AAA'], // the calendar spells it BRK/B
      makeStream: () => ({ setSymbols: () => {}, stop: () => {} }),
    });
    await lp.repick();
    await lp.quoteOnce();
    await lp.quoteOnce();
    expect(urls[0]).toContain('symbol=BRK.B');
    expect(Object.keys(lp.snapshot()).sort()).toEqual(['AAA', 'BRK-B']);
    expect(toFinnhub('BRK-B')).toBe('BRK.B');
    expect(toFinnhub('BRK/B')).toBe('BRK.B');
  });

  test('seeds come before round-robin polling', async () => {
    const { lp, finnhubCalls } = setup({ watched: names(52, 'W') });
    await lp.repick();
    for (let i = 0; i < 52; i++) await lp.quoteOnce();
    expect(new Set(finnhubCalls).size).toBe(52);
  });
});
