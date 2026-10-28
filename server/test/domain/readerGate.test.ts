import { describe, expect, it } from 'vitest';
import { GATE_MIN_EXACT, carriesValue, gateCounts, gateMarks, gatePasses, gateVerdict } from '../../src/domain/readerGate.js';
import { JP_GATE_FIELDS } from '../../src/jp/domain/readerGate.js';
import { EUROPE_GATE_FIELDS } from '../../src/europe/sources/releaseEurope.js';

const jp = (revenue: number | null, eps: number | null, epsDiluted: number | null = eps) => ({
  revenue, eps, epsDiluted, currency: revenue ?? eps ?? epsDiluted ? 'JPY' : null, span: revenue ?? eps ?? epsDiluted ? 'quarter' : null, ytdMonths: null,
});
const JP_NULL = jp(null, null, null);

describe('shared reader gate scoring', () => {
  it('JP: six fields; exact, blank, wrong', () => {
    expect(GATE_MIN_EXACT).toBe(20);
    expect(gateMarks(JP_GATE_FIELDS, jp(1, 2), { ...jp(1, 2), eps: null, epsDiluted: 9 })).toEqual(['exact', 'blank', 'wrong', 'exact', 'exact', 'exact']);
    expect(gateVerdict(JP_GATE_FIELDS, jp(1, 2), jp(1, 2))).toBe('exact');
    expect(gateVerdict(JP_GATE_FIELDS, jp(1, 2), { ...jp(1, 2), eps: null })).toBe('blank');
    expect(gateVerdict(JP_GATE_FIELDS, jp(1, 2), jp(1, 3))).toBe('wrong');
    expect(carriesValue(JP_GATE_FIELDS, JP_NULL)).toBe(false);
    expect(carriesValue(JP_GATE_FIELDS, jp(null, 2))).toBe(true);
  });

  it('JP: an all-null expected entry read as all null is exact but never counts toward the >= 20 floor', () => {
    const rows = [
      ...Array.from({ length: 19 }, () => ({ expected: jp(1, 2), got: jp(1, 2) })),
      { expected: JP_NULL, got: JP_NULL },
    ];
    const c = gateCounts(JP_GATE_FIELDS, rows);
    expect(c).toEqual({ checked: 20, exact: 20, exactWithValues: 19, wrong: 0 });
    expect(gatePasses(c, false)).toBe(false);
    expect(gatePasses(gateCounts(JP_GATE_FIELDS, [...rows, { expected: jp(5, 6), got: jp(5, 6) }]), false)).toBe(true);
  });

  it('JP: held-out passes with 0 wrong (blanks allowed); one wrong fails any set', () => {
    expect(gatePasses(gateCounts(JP_GATE_FIELDS, [{ expected: jp(1, 2), got: JP_NULL }]), true)).toBe(true);
    expect(gatePasses(gateCounts(JP_GATE_FIELDS, []), true)).toBe(false);
    const wrong = gateCounts(JP_GATE_FIELDS, [...Array.from({ length: 25 }, () => ({ expected: jp(1, 2), got: jp(1, 2) })), { expected: jp(1, 2), got: jp(1, 9) }]);
    expect(wrong.wrong).toBe(1);
    expect(gatePasses(wrong, false)).toBe(false);
    expect(gatePasses(wrong, true)).toBe(false);
  });

  it('Europe: seven fields; a GBp / GBP mix-up is wrong, never exact', () => {
    expect(EUROPE_GATE_FIELDS).toEqual(['revenue', 'revenueCurrency', 'eps', 'epsDiluted', 'epsCurrency', 'span', 'ytdMonths']);
    const e = { revenue: 1_234_000_000, revenueCurrency: 'GBP', eps: 12.3, epsDiluted: 12.1, epsCurrency: 'GBp', span: 'quarter', ytdMonths: null };
    expect(gateMarks(EUROPE_GATE_FIELDS, e, e)).toHaveLength(7);
    expect(gateVerdict(EUROPE_GATE_FIELDS, e, { ...e, epsCurrency: 'GBP' })).toBe('wrong');
    expect(gateVerdict(EUROPE_GATE_FIELDS, e, { ...e, revenueCurrency: null, revenue: null })).toBe('blank');
    const c = gateCounts(EUROPE_GATE_FIELDS, Array.from({ length: 20 }, () => ({ expected: e, got: e })));
    expect(c).toEqual({ checked: 20, exact: 20, exactWithValues: 20, wrong: 0 });
    expect(gatePasses(c, false)).toBe(true);
  });
});
