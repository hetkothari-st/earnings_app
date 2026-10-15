import { describe, expect, test } from 'vitest';
import { parseIntOrNull, parseNumber } from '../../src/domain/parse.js';

describe('parseNumber', () => {
  test('dollar amounts with separators', () => {
    expect(parseNumber('$2,308,617,010,000')).toBe(2308617010000);
    expect(parseNumber('$4.45')).toBe(4.45);
  });
  test('negative forms', () => {
    expect(parseNumber('$-0.76')).toBe(-0.76);
    expect(parseNumber('($0.76)')).toBe(-0.76);
    expect(parseNumber('-3.2')).toBe(-3.2);
  });
  test('plain numbers and numeric input', () => {
    expect(parseNumber('10.69')).toBe(10.69);
    expect(parseNumber(7)).toBe(7);
  });
  test('missing values are null, never 0', () => {
    for (const v of [null, undefined, '', ' ', 'N/A', 'NA', '--', '-', '$']) {
      expect(parseNumber(v)).toBeNull();
    }
  });
});

describe('parseIntOrNull', () => {
  test('integers and missing', () => {
    expect(parseIntOrNull('6')).toBe(6);
    expect(parseIntOrNull('N/A')).toBeNull();
  });
});
