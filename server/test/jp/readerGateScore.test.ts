import { describe, expect, it } from 'vitest';
import { JP_GATE_FIELDS, jpGateCounts, jpGatePasses, jpVerdict } from '../../src/jp/domain/readerGate.js';

const v = (revenue: number | null, eps: number | null, epsDiluted: number | null = eps) => ({
  revenue, eps, epsDiluted, currency: revenue ?? eps ?? epsDiluted ? 'JPY' : null, span: revenue ?? eps ?? epsDiluted ? 'quarter' : null, ytdMonths: null,
});
const ALL_NULL = v(null, null, null);

describe('JP reader gate scoring', () => {
  it('six fields; exact, blank, wrong', () => {
    expect(JP_GATE_FIELDS).toEqual(['revenue', 'eps', 'epsDiluted', 'currency', 'span', 'ytdMonths']);
    expect(jpVerdict(v(1, 2), v(1, 2))).toBe('exact');
    expect(jpVerdict(v(1, 2), { ...v(1, 2), eps: null })).toBe('blank');
    expect(jpVerdict(v(1, 2), v(1, 3))).toBe('wrong');
  });

  it('an all-null expected entry read as all null is exact but never counts toward the >= 20 floor', () => {
    const rows = [
      ...Array.from({ length: 19 }, () => ({ expected: v(1, 2), got: v(1, 2) })),
      { expected: ALL_NULL, got: ALL_NULL },
    ];
    const c = jpGateCounts(rows);
    expect(c).toEqual({ checked: 20, exact: 20, exactWithValues: 19, wrong: 0 });
    expect(jpGatePasses(c, false)).toBe(false);
    expect(jpGatePasses(jpGateCounts([...rows, { expected: v(5, 6), got: v(5, 6) }]), false)).toBe(true);
  });

  it('held-out: any checked set with 0 wrong passes (blanks allowed); one wrong fails any set', () => {
    expect(jpGatePasses(jpGateCounts([{ expected: v(1, 2), got: ALL_NULL }]), true)).toBe(true);
    expect(jpGatePasses(jpGateCounts([]), true)).toBe(false);
    const wrong = jpGateCounts([...Array.from({ length: 25 }, () => ({ expected: v(1, 2), got: v(1, 2) })), { expected: v(1, 2), got: v(1, 9) }]);
    expect(wrong.wrong).toBe(1);
    expect(jpGatePasses(wrong, false)).toBe(false);
    expect(jpGatePasses(wrong, true)).toBe(false);
  });
});
