import { describe, expect, test } from 'vitest';
import { formatDateHeading, formatEps, formatPct, formatUsd, formatUsdFull } from '../src/lib/format';

describe('format', () => {
  test('formatUsd compact', () => {
    expect(formatUsd(2_308_617_010_000)).toBe('$2.31T');
    expect(formatUsd(165_912_461_000)).toBe('$165.9B');
    expect(formatUsd(512_300_000)).toBe('$512.3M');
    expect(formatUsd(-1_500_000_000)).toBe('-$1.5B');
    expect(formatUsd(null)).toBe('—');
  });
  test('formatUsdFull', () => {
    expect(formatUsdFull(47_100_000_000)).toBe('$47,100,000,000');
  });
  test('formatEps', () => {
    expect(formatEps(1.66)).toBe('$1.66');
    expect(formatEps(-0.76)).toBe('-$0.76');
    expect(formatEps(null)).toBe('—');
  });
  test('formatPct', () => {
    expect(formatPct(3)).toBe('+3.0%');
    expect(formatPct(-7.04)).toBe('-7.0%');
    expect(formatPct(null)).toBe('—');
  });
  test('formatDateHeading', () => {
    expect(formatDateHeading('2026-10-15')).toBe('Thu, Oct 15, 2026');
  });
});
