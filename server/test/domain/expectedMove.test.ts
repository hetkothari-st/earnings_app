import { describe, expect, test } from 'vitest';
import { chooseExpiry, computeExpectedMove, parseOptionSymbol } from '../../src/domain/expectedMove.js';
import type { OptionChain, OptionQuote } from '../../src/types.js';

const q = (expiry: string, type: 'C' | 'P', strike: number, bid: number, ask: number): OptionQuote =>
  ({ expiry, type, strike, bid, ask });

function chain(underlying: number, extra: OptionQuote[] = []): OptionChain {
  return {
    underlying,
    quotes: [
      q('2026-10-16', 'C', 95, 6.0, 6.4), q('2026-10-16', 'P', 95, 0.9, 1.1),
      q('2026-10-16', 'C', 100, 2.9, 3.1), q('2026-10-16', 'P', 100, 2.9, 3.1),
      q('2026-10-16', 'C', 105, 0.9, 1.1), q('2026-10-16', 'P', 105, 6.0, 6.4),
      q('2026-10-23', 'C', 100, 4.4, 4.6), q('2026-10-23', 'P', 100, 4.4, 4.6),
      ...extra,
    ],
  };
}

describe('parseOptionSymbol', () => {
  test('OCC-style symbols', () => {
    expect(parseOptionSymbol('JPM261016C00180000')).toEqual({ expiry: '2026-10-16', type: 'C', strike: 180 });
    expect(parseOptionSymbol('BRKB261016P00412500')).toEqual({ expiry: '2026-10-16', type: 'P', strike: 412.5 });
    expect(parseOptionSymbol('garbage')).toBeNull();
  });
});

describe('chooseExpiry', () => {
  const exp = ['2026-10-23', '2026-10-16', '2026-10-16'];
  test('BMO may use an expiry on the report date', () => {
    expect(chooseExpiry(exp, '2026-10-16', 'BMO')).toBe('2026-10-16');
  });
  test('AMC, DMH and UNKNOWN need an expiry strictly after the report date', () => {
    expect(chooseExpiry(exp, '2026-10-16', 'AMC')).toBe('2026-10-23');
    expect(chooseExpiry(exp, '2026-10-16', 'DMH')).toBe('2026-10-23');
    expect(chooseExpiry(exp, '2026-10-16', 'UNKNOWN')).toBe('2026-10-23');
  });
  test('none qualifies -> null', () => {
    expect(chooseExpiry(exp, '2026-10-23', 'AMC')).toBeNull();
  });
});

describe('computeExpectedMove', () => {
  test('ATM straddle mid / price', () => {
    expect(computeExpectedMove(chain(100), '2026-10-16', 'BMO')).toEqual({
      expiry: '2026-10-16', strike: 100, callMid: 3, putMid: 3, underlying: 100, movePct: 6, illiquid: false,
    });
  });
  test('AMC uses the next expiry', () => {
    expect(computeExpectedMove(chain(100), '2026-10-16', 'AMC')?.movePct).toBe(9);
  });
  test('equidistant strikes pick the lower one', () => {
    const em = computeExpectedMove(chain(102.5), '2026-10-16', 'BMO');
    expect(em?.strike).toBe(100);
    expect(em?.movePct).toBe(5.85);
  });
  test('no strike within 10% of the price gives no value (live LOOP: $0.34 stock, $0.50 strike)', () => {
    const c: OptionChain = { underlying: 0.342, quotes: [
      q('2026-10-16', 'C', 0.5, 0.05, 0.6), q('2026-10-16', 'P', 0.5, 0.1, 0.45),
    ] };
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')).toBeNull();
  });
  test('zero bid is flagged illiquid', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 && x.type === 'P' ? { ...x, bid: 0 } : x));
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.illiquid).toBe(true);
  });
  test('spread over 30% of mid is flagged illiquid', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 && x.type === 'C' ? { ...x, bid: 2, ask: 4 } : x));
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.illiquid).toBe(true);
  });
  test('strikes with no ask (no market) are skipped before choosing ATM', () => {
    const c = chain(100);
    c.quotes = c.quotes.map((x) => (x.expiry === '2026-10-16' && x.strike === 100 ? { ...x, bid: 0, ask: 0 } : x));
    // 95 and 105 are equidistant from 100; the lower one wins.
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')?.strike).toBe(95);
  });
  test('strike must have both call and put', () => {
    const c: OptionChain = { underlying: 100, quotes: [q('2026-10-16', 'C', 100, 2.9, 3.1)] };
    expect(computeExpectedMove(c, '2026-10-16', 'BMO')).toBeNull();
  });
  test('no options or bad price -> null', () => {
    expect(computeExpectedMove({ underlying: 100, quotes: [] }, '2026-10-16', 'BMO')).toBeNull();
    expect(computeExpectedMove({ ...chain(100), underlying: 0 }, '2026-10-16', 'BMO')).toBeNull();
  });
});
