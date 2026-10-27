import { describe, it, expect } from 'vitest';
import { HK_UNIVERSE, HK_INDICES, hkLevel, yahooHkSymbol } from '../../src/hk/universe.js';

describe('hk universe', () => {
  it('codes are unique 4-digit strings and full-level entries have all three of adr, ratio, cik', () => {
    const codes = HK_UNIVERSE.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of HK_UNIVERSE) {
      expect(e.code).toMatch(/^\d{4}$/);
      if (hkLevel(e) === 'full') {
        expect(e.adr).toBeTruthy();
        expect(e.adrRatio).toBeGreaterThan(0);
        expect(e.cik).toBeGreaterThan(0);
      } else {
        expect(e.adr === null || e.cik === null).toBe(true);
      }
    }
  });
  it('basic list size', () => {
    const n = HK_UNIVERSE.filter((e) => hkLevel(e) === 'basic').length;
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(90);
  });
  it('full-level count', () => {
    const n = HK_UNIVERSE.filter((e) => hkLevel(e) === 'full').length;
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(20);
  });
  it('yahooHkSymbol pads nothing and appends .HK', () => {
    expect(yahooHkSymbol('0700')).toBe('0700.HK');
  });
  it('cadence and fyEndMonth valid', () => {
    for (const e of HK_UNIVERSE) {
      expect(['Q', 'H']).toContain(e.cadence);
      expect(e.fyEndMonth).toBeGreaterThanOrEqual(1);
      expect(e.fyEndMonth).toBeLessThanOrEqual(12);
    }
    expect(HK_INDICES.map((i) => i.yahoo)).toEqual(['^HSI', '^HSCE', 'HSTECH.HK']);
  });
});
