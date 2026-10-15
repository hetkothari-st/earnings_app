import { describe, expect, test } from 'vitest';
import { rangeFor, shiftAnchor } from '../src/lib/ranges';

describe('rangeFor', () => {
  test('day, week (Mon–Fri), month, quarter', () => {
    expect(rangeFor('day', '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(rangeFor('week', '2026-10-15')).toEqual({ from: '2026-10-12', to: '2026-10-16' });
    expect(rangeFor('month', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangeFor('quarter', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });
});

describe('shiftAnchor', () => {
  test('day skips weekends', () => {
    expect(shiftAnchor('day', '2026-10-16', 1)).toBe('2026-10-19');
    expect(shiftAnchor('day', '2026-10-19', -1)).toBe('2026-10-16');
  });
  test('week, month, quarter', () => {
    expect(shiftAnchor('week', '2026-10-15', 1)).toBe('2026-10-22');
    expect(shiftAnchor('month', '2026-10-15', -1)).toBe('2026-09-15');
    expect(shiftAnchor('quarter', '2026-10-15', 1)).toBe('2027-01-15');
  });
});
