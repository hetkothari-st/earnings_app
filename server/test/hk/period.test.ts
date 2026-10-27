import { describe, it, expect } from 'vitest';
import { hkPeriodFor, hkPeriodLabel } from '../../src/hk/domain/period.js';

describe('hk period', () => {
  it('period from report date and cadence', () => {
    expect(hkPeriodFor('2026-11-20', 'Q', 3)).toEqual({ periodEnd: '2026-09-30', kind: 'Q' });
    expect(hkPeriodFor('2026-08-19', 'H', 12)).toEqual({ periodEnd: '2026-06-30', kind: 'H' });
    expect(hkPeriodFor('2027-03-18', 'H', 12)).toEqual({ periodEnd: '2026-12-31', kind: 'FY' });
    expect(hkPeriodFor('2026-11-25', 'H', 3)).toEqual({ periodEnd: '2026-09-30', kind: 'H' });
    expect(hkPeriodFor('2027-05-20', 'H', 3)).toEqual({ periodEnd: '2027-03-31', kind: 'FY' });
  });
  it('labels', () => {
    expect(hkPeriodLabel('2026-09-30', 'Q', 3)).toBe('Q3 26');
    expect(hkPeriodLabel('2026-06-30', 'H', 12)).toBe('1H26');
    expect(hkPeriodLabel('2026-12-31', 'FY', 12)).toBe('FY26');
    expect(hkPeriodLabel('2026-09-30', 'H', 3)).toBe('1H27');
  });
});
