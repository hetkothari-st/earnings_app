import { describe, it, expect } from 'vitest';
import { impliedAdrRatio, parseRatioPhrase, ratioAgrees } from '../../src/cli/verifyJpUniverse.js';
import { JP_FULL, jpAdrRatioShown } from '../../src/jp/universe.js';

describe('parseRatioPhrase', () => {
  it('words, decimals and fractions', () => {
    expect(parseRatioPhrase('ten')).toBe(10);
    expect(parseRatioPhrase('one')).toBe(1);
    expect(parseRatioPhrase('0.2')).toBe(0.2);
    expect(parseRatioPhrase('one-fifth of one')).toBe(0.2);
    expect(parseRatioPhrase('one-half of one')).toBe(0.5);
    expect(parseRatioPhrase('two-tenths')).toBeCloseTo(0.2);
    expect(parseRatioPhrase('1/5')).toBeCloseTo(0.2);
    expect(parseRatioPhrase('gibberish')).toBeNull();
  });
});

describe('ADR ratio cross-check (display only when verified)', () => {
  it('price-implied ratio: ADR close × USD/JPY ÷ Tokyo close', () => {
    // TM: $190 × 150 ¥/$ ÷ ¥2,850 = 10.0 shares per ADS.
    expect(impliedAdrRatio(190, 150, 2850)).toBeCloseTo(10);
    expect(impliedAdrRatio(190, 150, 0)).toBeNull();
    expect(impliedAdrRatio(Number.NaN, 150, 2850)).toBeNull();
  });

  it('agrees within 15% of the 20-F ratio', () => {
    expect(ratioAgrees(10, 10)).toBe(true);
    expect(ratioAgrees(10, 11.4)).toBe(true);
    expect(ratioAgrees(10, 8.6)).toBe(true);
    expect(ratioAgrees(10, 11.6)).toBe(false);
    expect(ratioAgrees(2, 1)).toBe(false);
    expect(ratioAgrees(2, null)).toBe(false);
  });

  it('the ratio is served only for an entry recorded as verified', () => {
    const list = [
      { code: '7203', adr: 'TM', adrRatio: 10, cik: 1, adrRatioVerified: true },
      { code: '8411', adr: 'MFG', adrRatio: 2, cik: 2, adrRatioVerified: false },
    ];
    expect(jpAdrRatioShown('7203', 10, list)).toBe(10);
    expect(jpAdrRatioShown('8411', 2, list)).toBeNull();
    expect(jpAdrRatioShown('6501', 5, list)).toBeNull();
    expect(jpAdrRatioShown('7203', null, list)).toBeNull();
    // Every full-level entry records the verification outcome.
    for (const e of JP_FULL) expect(typeof e.adrRatioVerified, e.code).toBe('boolean');
  });
});
