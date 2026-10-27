import { describe, expect, test } from 'vitest';
import { formatDateHeading, formatEps, formatHkEps, formatHkMoney, formatHkPrice, formatJpEps, formatJpMoney, formatJpPrice, formatPct, formatUsd, formatUsdFull, ytdLabel } from '../src/lib/format';

describe('Japan formats', () => {
  test('yen price, money, EPS and ytdLabel', () => {
    expect(formatJpPrice(2845.5)).toBe('¥2,845.5');
    expect(formatJpPrice(3120)).toBe('¥3,120');
    expect(formatJpPrice(null)).toBe('—');
    expect(formatJpMoney(48_036_704_000_000, 'JPY')).toBe('¥48.04T');
    expect(formatJpMoney(12.4e9, 'JPY')).toBe('¥12.4B');
    expect(formatJpMoney(null, 'JPY')).toBe('—');
    expect(formatJpMoney(2e9, 'USD')).toBe('USD 2.0B');
    expect(formatJpMoney(2e9, null)).toBe('2.0B');
    expect(formatJpEps(239.1, 'JPY')).toBe('¥239.10');
    expect(formatJpEps(-5, 'JPY')).toBe('−¥5.00');
    expect(formatJpEps(1, null)).toBe('1.00');
    expect(ytdLabel(9)).toBe('YTD (9 months)');
    expect(ytdLabel(null)).toBeNull();
  });
});

describe('Hong Kong formats', () => {
  test('formatHkMoney prefixes by currency and stays compact', () => {
    expect(formatHkMoney(247_652_000_000, 'CNY')).toBe('RMB¥247.7B');
    expect(formatHkMoney(3.2e12, 'HKD')).toBe('HK$3.20T');
    expect(formatHkMoney(5_100_000, 'USD')).toBe('US$5.1M');
    expect(formatHkMoney(-1.5e9, 'CNY')).toBe('-RMB¥1.5B');
    expect(formatHkMoney(2e9, 'SGD')).toBe('SGD 2.0B');
    expect(formatHkMoney(null, 'CNY')).toBe('—');
    // No currency on record: no prefix (never a guessed HK$).
    expect(formatHkMoney(2e9, null)).toBe('2.0B');
    expect(formatHkEps(-0.5, null)).toBe('−0.50');
    expect(formatHkEps(1.1, undefined)).toBe('1.10');
  });
  test('formatHkEps uses a true minus and the stated currency', () => {
    expect(formatHkEps(1.1, 'CNY')).toBe('RMB¥1.10');
    expect(formatHkEps(-0.05, 'USD')).toBe('−US$0.05');
    expect(formatHkEps(0.3, 'HKD')).toBe('HK$0.30');
    expect(formatHkEps(0.3, 'SGD')).toBe('SGD 0.30');
    expect(formatHkEps(null, 'CNY')).toBe('—');
  });
  test('formatHkPrice is HK$ with two decimals', () => {
    expect(formatHkPrice(612.5)).toBe('HK$612.50');
    expect(formatHkPrice(1234.5)).toBe('HK$1,234.50');
  });
});

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
