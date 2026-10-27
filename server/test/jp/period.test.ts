import { describe, it, expect } from 'vitest';
import { jpPeriodFor, jpPeriodLabel, ytdMonthsOf } from '../../src/jp/domain/period.js';

describe('jp period', () => {
  it('period, quarter and label', () => {
    const cases: Array<[string, number, string, 1 | 2 | 3 | 4, string, string]> = [
      ['2026-11-05', 3, '2026-09-30', 2, '2027-03-31', '2Q FY27'],
      ['2026-05-08', 3, '2026-03-31', 4, '2026-03-31', 'FY26'],
      ['2027-02-12', 12, '2026-12-31', 4, '2026-12-31', 'FY26'],
      ['2026-10-09', 2, '2026-08-31', 2, '2027-02-28', '2Q FY27'],
      ['2026-10-08', 8, '2026-08-31', 4, '2026-08-31', 'FY26'],
    ];
    for (const [rd, m, pe, q, fy, label] of cases) {
      const p = jpPeriodFor(rd, m);
      expect(p, rd).toEqual({ periodEnd: pe, fiscalQuarter: q, fyEnd: fy });
      expect(jpPeriodLabel(p)).toBe(label);
    }
    expect(ytdMonthsOf(3)).toBe(9);
    expect(ytdMonthsOf(1)).toBe(3);
    expect(ytdMonthsOf(4)).toBe(12);
  });
});
