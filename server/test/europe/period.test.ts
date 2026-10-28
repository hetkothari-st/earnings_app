import { describe, it, expect } from 'vitest';
import { europePeriodFor, europePeriodLabel } from '../../src/europe/domain/period.js';

describe('europePeriodFor', () => {
  it.each([
    ['2026-07-30', 12, '2026-06-30', 2, '2026-12-31', 'H1 FY26'],
    ['2026-11-05', 3, '2026-09-30', 2, '2027-03-31', 'H1 FY27'],
    ['2027-02-12', 12, '2026-12-31', 4, '2026-12-31', 'FY26'],
    ['2026-05-20', 12, '2026-03-31', 1, '2026-12-31', 'Q1 FY26'],
    ['2026-10-22', 6, '2026-09-30', 1, '2027-06-30', 'Q1 FY27'],
    ['2026-11-05', 12, '2026-09-30', 3, '2026-12-31', 'Q3 FY26'],
  ] as const)('%s fy-month %i', (date, m, end, q, fyEnd, label) => {
    const p = europePeriodFor(date, m);
    expect(p).toEqual({ periodEnd: end, fiscalQuarter: q, fyEnd });
    expect(europePeriodLabel(p)).toBe(label);
  });
});
